import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import { pcmToWav } from "@rakazo/adapters";
import type {
  Actor,
  ProductEvent,
  ThreadMessage,
  ThreadSnapshot,
  VoiceCallServerFrame,
} from "@rakazo/contracts";
import { VOICE_CALL_INPUT } from "@rakazo/contracts";
import type { SpeechFeed } from "@rakazo/core";
import {
  callClientNonce,
  callRunStatus,
  callTurn,
  createCallReplySpeech,
  createCallSendTracker,
  createSpeechFeed,
  isApprovalAskBlock,
  isRunTerminalEvent,
  isRunWorking,
  isSecretAskBlock,
  isThreadSnapshotEvent,
  pendingCallSecretAsk,
  reduceThreadSnapshot,
  runThreadSubscription,
  speechFromBlocks,
} from "@rakazo/core";
import { runAsTenant } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { createRouter } from "../../router.js";
import { voiceErrorReply } from "../../voice/http-errors.js";
import type { VoiceDeps } from "../voice.js";
import { synthesizeVoice, transcribeVoice } from "../voice.js";

type Router = ReturnType<typeof createRouter>;
type Clip = { bytes: Uint8Array; mimeType: string; renderMs: number };

/** How long each step of a turn took, from the moment the person let go, until its first audio. */
type TurnTiming = {
  endedAt: number;
  transcribeMs?: number;
  sentMs?: number;
  replyTextMs?: number;
};

export type VoiceCallDeps = VoiceDeps & { router: Router };

export type VoiceCallStart = {
  actor: Actor;
  sessionId: string;
  botId: string;
  callId: string;
  language?: string;
};

export type VoiceCallOutput = {
  send(frame: VoiceCallServerFrame): void;
  sendAudio(bytes: Uint8Array): void;
  /** Closes the socket once everything sent has been flushed. */
  close(): void;
};

export type VoiceCall = {
  /** Audio the person is saying, in the call's input format. */
  hear(pcm: Uint8Array): void;
  endTurn(): void;
  stop(): void;
  hangUp(reason: "hung_up" | "unavailable"): void;
};

const ROUTE = "/api/voice/call";

/** The most audio one turn may hold, the same bound a recording sent to transcribe has. */
export const MAX_TURN_PCM_BYTES = 8 * 1024 * 1024;

/**
 * One device call with a bot. It hears each held-to-talk turn, sends it into the bot's thread as
 * the app's call does, and says the reply sentence by sentence as the run writes it, rendering
 * the next utterance while the device plays the one before.
 */
export function startVoiceCall(
  deps: VoiceCallDeps,
  start: VoiceCallStart,
  out: VoiceCallOutput,
): VoiceCall {
  const { actor, botId, callId } = start;
  const controller = new AbortController();
  const { signal } = controller;
  const rpc: RouterClient<Router> = createRouterClient(deps.router, {
    context: { actor, sessionId: start.sessionId, signal },
  });
  const connectedAt = Date.now();
  const replySpeech = createCallReplySpeech();
  const sends = createCallSendTracker();
  const spokenMessageIds = new Set<string>();
  const finishedRunIds = new Set<string>();
  let thread: ThreadSnapshot | null = null;
  let heard: Uint8Array[] = [];
  let heardBytes = 0;
  let turns: Promise<void> = Promise.resolve();
  let awaitedRunId: string | null = null;
  let awaitingReply = false;
  /** The run whose reply is being said while it is still written. */
  let streamRunId: string | null = null;
  let botEndedCall = false;
  let ended = false;
  /** The latest turn, until its reply's first audio is sent. */
  let timing: TurnTiming | null = null;

  const send = (frame: VoiceCallServerFrame) => {
    if (!ended) out.send(frame);
  };

  const sinceTurn = (current: TurnTiming) => Date.now() - current.endedAt;

  const replyWritten = () => {
    if (timing) timing.replyTextMs ??= sinceTurn(timing);
  };

  const firstAudioSent = (clip: Clip, utterance: string) => {
    const current = timing;
    if (!current) return;
    timing = null;
    getLogger().info("voice_call.first_audio", {
      "call.id": callId,
      "bot.id": botId,
      "voice_call.transcribe_ms": current.transcribeMs,
      "voice_call.sent_ms": current.sentMs,
      "voice_call.reply_text_ms": current.replyTextMs,
      "voice_call.render_ms": clip.renderMs,
      "voice_call.first_audio_ms": sinceTurn(current),
      "voice_call.first_utterance_chars": utterance.length,
      "voice_call.first_audio_bytes": clip.bytes.byteLength,
    });
  };

  const newFeed = (): SpeechFeed =>
    createSpeechFeed<Clip>({
      prepare: async (text, feedSignal) =>
        (await rpc.voice.prepare({ text, botId }, { signal: feedSignal })).utterances,
      render: async (utterance, feedSignal) => {
        const started = Date.now();
        const clip = await runAsTenant(actor, () =>
          synthesizeVoice(deps, actor, { text: utterance, botId, callId, signal: feedSignal }),
        );
        return { ...clip, renderMs: Date.now() - started };
      },
      // The device queues what it gets and plays it in order, so a clip is done once it is sent.
      play: async (clip, utterance) => {
        send({ type: "say", text: utterance, mimeType: clip.mimeType });
        if (ended) return;
        out.sendAudio(clip.bytes);
        firstAudioSent(clip, utterance);
      },
    });
  let feed = newFeed();

  const say = (text: string, runId?: string) => {
    const current = feed;
    return current.push(text).catch((error: unknown) => {
      // What was taken may not have been heard: the finished reply is said whole instead.
      if (runId) replySpeech.forget(runId);
      if (current === feed) feed = newFeed();
      send({ type: "error", message: voiceErrorReply(error, ROUTE).body.error });
    });
  };

  const runWorking = (runId: string) =>
    !finishedRunIds.has(runId) && isRunWorking(callRunStatus(thread, runId));

  /** A reply is only whole once its own run stopped. */
  const replyFinished = (message: ThreadMessage) => {
    const run = thread?.activeRuns?.find((active) => active.id === message.runId) ?? thread?.run;
    if (!run || (message.runId && message.runId !== run.id)) return true;
    return !isRunWorking(run.status);
  };

  /** Says the bot's reply to the latest turn: as it is written, then what the finished one adds. */
  const react = () => {
    if (!thread || ended || botEndedCall || !awaitingReply) return;
    if (pendingCallSecretAsk(thread)) {
      awaitingReply = false;
      send({ type: "state", phase: "on_screen" });
      return;
    }
    const messages = thread.messages;
    const replyRunId = awaitedRunId;
    if (replyRunId && runWorking(replyRunId)) {
      const sentences = replySpeech.take(messages, replyRunId);
      if (sentences) {
        streamRunId = replyRunId;
        replyWritten();
        void say(sentences, replyRunId);
      }
    }
    const turnIndex = messages.findLastIndex((message) => message.role === "user");
    const lastBot = messages
      .slice(turnIndex + 1)
      .findLast(
        (message) =>
          message.role === "bot" &&
          !(message.id.startsWith("progress:") && replyFinished(message)) &&
          (!replyRunId || message.runId === replyRunId),
      );
    if (lastBot && !spokenMessageIds.has(lastBot.id) && replyFinished(lastBot)) {
      const text = speechFromBlocks(lastBot.blocks);
      const ask = lastBot.blocks.find(
        (block) => block.kind === "ask" && block.status !== "answered",
      );
      const onScreen = Boolean(ask && (isApprovalAskBlock(ask) || isSecretAskBlock(ask)));
      if (text) {
        spokenMessageIds.add(lastBot.id);
        // An approval is given on screen and sends no turn: the reply its run writes next follows.
        awaitingReply = onScreen && ask !== undefined && isApprovalAskBlock(ask);
        if (lastBot.runId === streamRunId) streamRunId = null;
        const rest = lastBot.runId ? replySpeech.finish(lastBot.runId, text, lastBot.id) : text;
        // The new phase follows the reply's last audio, so the device knows the reply is whole.
        const phase = onScreen ? "on_screen" : "listening";
        if (rest) replyWritten();
        void (rest ? say(rest) : Promise.resolve()).then(() => send({ type: "state", phase }));
        return;
      }
      if (!isRunWorking(thread.run?.status)) {
        spokenMessageIds.add(lastBot.id);
        awaitingReply = false;
        send({ type: "state", phase: "listening" });
        return;
      }
    }
    if (replyRunId && finishedRunIds.has(replyRunId)) {
      awaitingReply = false;
      awaitedRunId = null;
      send({ type: "state", phase: "listening" });
    }
  };

  /** The bot hung up: say its goodbye, then end the call. Its marker is already filed. */
  const botHungUp = (payload: Record<string, unknown>) => {
    if (botEndedCall) return;
    botEndedCall = true;
    if (typeof payload.messageId === "string") spokenMessageIds.add(payload.messageId);
    if (streamRunId) replySpeech.seal(thread?.messages ?? [], streamRunId);
    streamRunId = null;
    const farewell = typeof payload.farewell === "string" ? payload.farewell.trim() : "";
    void (farewell ? say(farewell) : Promise.resolve()).then(() => finish("bot"));
  };

  const load = async () => {
    const next = await rpc.threads.get({ botId }, { signal });
    if (thread?.threadId === next.threadId && thread.cursor > next.cursor) return thread;
    thread = next;
    react();
    return thread;
  };

  const runTurn = async (pcm: Uint8Array, endedAt: number) => {
    send({ type: "state", phase: "thinking" });
    const turnTiming: TurnTiming = { endedAt };
    timing = null;
    try {
      const { text } = await runAsTenant(actor, () =>
        transcribeVoice(deps, actor, {
          audio: pcmToWav(pcm, VOICE_CALL_INPUT),
          mimeType: "audio/wav",
          language: start.language,
          callId,
          signal,
        }),
      );
      const words = text.trim();
      turnTiming.transcribeMs = sinceTurn(turnTiming);
      send({ type: "heard", text: words });
      if (!words) {
        send({ type: "state", phase: awaitingReply ? "thinking" : "listening" });
        return;
      }
      const current = await rpc.threads.get({ botId }, { signal });
      const turn = callTurn(current, words);
      if (turn.kind === "enter_code" || turn.kind === "approve_on_screen") {
        send({ type: "state", phase: "on_screen" });
        return;
      }
      // A new turn cuts off what was still being said of the reply before it.
      if (streamRunId) replySpeech.seal(thread?.messages ?? [], streamRunId);
      streamRunId = null;
      const clientNonce = callClientNonce(callId);
      const request =
        turn.kind === "answer"
          ? rpc.threads.answer({
              botId,
              runId: turn.runId,
              messageId: turn.messageId,
              answer: turn.answer,
              clientNonce,
            })
          : turn.kind === "follow_up"
            ? rpc.threads.followUp({ botId, text: words, clientNonce })
            : rpc.threads.send({ botId, text: words, clientNonce });
      const release = sends.track(callId, request);
      try {
        const receipt = await request;
        turnTiming.sentMs = sinceTurn(turnTiming);
        timing = turnTiming;
        awaitedRunId =
          turn.kind === "answer"
            ? turn.runId
            : "runId" in receipt && typeof receipt.runId === "string"
              ? receipt.runId
              : (current.run?.id ?? null);
      } finally {
        release();
      }
      awaitingReply = true;
      await load();
    } catch (error) {
      if (signal.aborted) return;
      send({ type: "error", message: voiceErrorReply(error, ROUTE).body.error });
      send({ type: "state", phase: awaitingReply ? "thinking" : "listening" });
    }
  };

  const finish = (reason: "hung_up" | "bot" | "signed_out" | "unavailable") => {
    if (ended) return;
    feed.stop();
    if (!botEndedCall) {
      // A hang-up closes the call server-side, which files its marker and lets the bot finish
      // what was asked on it, once every turn still being sent has landed.
      const closer: RouterClient<Router> = createRouterClient(deps.router, {
        context: { actor, sessionId: start.sessionId },
      });
      const durationSeconds = Math.round((Date.now() - connectedAt) / 1000);
      void bestEffort(
        "end a voice device call",
        sends.closeAfterSends(callId, () =>
          closer.threads.endCall({ botId, callId, durationSeconds }),
        ),
      );
    }
    send({ type: "ended", reason });
    ended = true;
    controller.abort();
    out.close();
  };

  void runThreadSubscription({
    signal,
    loadInitial: load,
    loadHead: () => rpc.threads.head({ botId }, { signal }),
    refresh: load,
    currentSnapshot: () => thread,
    subscribe: (cursor, subscribeSignal) =>
      rpc.threads.subscribe({ botId, cursor }, { signal: subscribeSignal }),
    applyEvent: (event: ProductEvent) => {
      if (event.runId && isRunTerminalEvent(event)) finishedRunIds.add(event.runId);
      if (isThreadSnapshotEvent(event)) thread = reduceThreadSnapshot(thread, event);
    },
    onEvent: (event: ProductEvent) => {
      if (event.type === "thread.call.ended" && event.payload?.callId === callId) {
        botHungUp(event.payload);
        return;
      }
      react();
    },
  }).then(
    // The stream only stops for good when the session can no longer read the thread.
    () => finish(signal.aborted ? "hung_up" : "signed_out"),
    () => finish("unavailable"),
  );
  send({ type: "state", phase: "listening" });

  return {
    hear(pcm) {
      if (ended || heardBytes + pcm.byteLength > MAX_TURN_PCM_BYTES) return;
      heard.push(pcm);
      heardBytes += pcm.byteLength;
    },
    endTurn() {
      if (ended) return;
      const endedAt = Date.now();
      const pcm = Buffer.concat(heard);
      heard = [];
      heardBytes = 0;
      turns = turns.then(() => runTurn(new Uint8Array(pcm), endedAt));
    },
    stop() {
      feed.stop();
      feed = newFeed();
      if (streamRunId) replySpeech.seal(thread?.messages ?? [], streamRunId);
      streamRunId = null;
    },
    hangUp: finish,
  };
}
