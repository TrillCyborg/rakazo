import type { RouterClient } from "@orpc/server";
import { createRouterClient } from "@orpc/server";
import type { ThreadMessage, ThreadSnapshot, VoiceTurnResult } from "@rakazo/contracts";
import { VoiceTurnInputSchema } from "@rakazo/contracts";
import {
  callClientNonce,
  callTurn,
  deadlineSignal,
  isApprovalAskBlock,
  isSecretAskBlock,
  speechFromBlocks,
} from "@rakazo/core";
import { runAsTenant } from "@rakazo/db";
import type { Hono } from "hono";
import type { requestSessions } from "../auth/request-session.js";
import { readBoundedBody } from "../http/http-body.js";
import type { createRouter } from "../router.js";
import { voiceHttpError } from "../voice/http-errors.js";
import type { VoiceDeps } from "./voice.js";
import { MAX_TRANSCRIBE_REQUEST_BYTES, transcribeVoice } from "./voice.js";

/** How long a turn waits for the bot's reply before telling the device it is still working. */
export const VOICE_TURN_REPLY_WAIT_MS = 120_000;

/** The run events after which a turn's run has nothing more to say until someone answers. */
const SETTLED = new Set(["run.completed", "run.failed", "run.cancelled", "run.waiting_input"]);

type Router = ReturnType<typeof createRouter>;

/**
 * `POST /api/voice/turn`: one spoken turn from a device that cannot run the app's call screen.
 * The server hears the recording, sends it into the bot's thread as the app's call would (an
 * answer to an open question, a follow-up to work in progress, or a new message), waits for
 * the reply, and returns it as utterances the device speaks with `/api/voice/speak`. The turn
 * and the reply are ordinary thread messages, so they show in the app like any other.
 */
export function mountVoiceTurnRoute(
  app: Hono,
  deps: VoiceDeps & { router: Router },
  requestSession: ReturnType<typeof requestSessions>["requestSession"],
) {
  app.post("/api/voice/turn", async (c) => {
    const session = await requestSession(c.req.raw);
    const actor = session?.actor;
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MAX_TRANSCRIBE_REQUEST_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    const input = VoiceTurnInputSchema.safeParse(parseJson(raw));
    if (!input.success) return c.json({ error: "Invalid voice turn." }, 400);
    const { botId } = input.data;
    const signal = c.req.raw.signal;
    const rpc = createRouterClient(deps.router, {
      context: { actor, sessionId: session.sessionId, signal },
    });
    try {
      const { text } = await runAsTenant(actor, () =>
        transcribeVoice(deps, actor, {
          audio: new Uint8Array(Buffer.from(input.data.audioBase64, "base64")),
          mimeType: input.data.mimeType,
          language: input.data.language,
          signal,
        }),
      );
      const heard = text.trim();
      if (!heard) return c.json(result("unheard", "", []));

      const thread = await rpc.threads.get({ botId });
      const turn = callTurn(thread, heard);
      if (turn.kind === "enter_code" || turn.kind === "approve_on_screen") {
        return c.json(result("on_screen", heard, []));
      }
      // A call message: the bot answers in short spoken sentences and the app shows one call.
      const clientNonce = callClientNonce(input.data.callId);
      let runId: string | undefined;
      let cursor = thread.cursor;
      if (turn.kind === "answer") {
        await rpc.threads.answer({
          botId,
          runId: turn.runId,
          messageId: turn.messageId,
          answer: turn.answer,
          clientNonce,
        });
        runId = turn.runId;
      } else if (turn.kind === "follow_up") {
        await rpc.threads.followUp({ botId, text: heard, clientNonce });
        runId = thread.run?.id;
      } else {
        const receipt = await rpc.threads.send({ botId, text: heard, clientNonce });
        runId = receipt.runId;
        cursor = receipt.seq;
      }
      if (!runId) return c.json(result("working", heard, []));

      const settled = await waitForRun(rpc, botId, runId, cursor, signal);
      if (!settled) return c.json(result("working", heard, []));
      const after = await rpc.threads.get({ botId });
      const reply = replyTo(after, runId);
      const speech = reply ? speechFromBlocks(reply.blocks) : "";
      const askOnScreen = reply?.blocks.some(
        (block) =>
          block.kind === "ask" &&
          block.status !== "answered" &&
          (isApprovalAskBlock(block) || isSecretAskBlock(block)),
      );
      const say = speech ? (await rpc.voice.prepare({ text: speech, botId })).utterances : [];
      if (askOnScreen) return c.json(result("on_screen", heard, say));
      if (say.length > 0) return c.json(result("replied", heard, say));
      const run = after.activeRuns?.find((active) => active.id === runId) ?? after.run;
      return c.json(
        result(run?.id === runId && run.status === "failed" ? "failed" : "replied", heard, say),
      );
    } catch (error) {
      return voiceHttpError(c, error);
    }
  });
}

function result(status: VoiceTurnResult["status"], heard: string, say: string[]): VoiceTurnResult {
  return { status, heard, say };
}

/**
 * Follows the thread from `cursor` until `runId` completes, fails, stops or waits for input.
 * False when the reply takes longer than a device should hold the request open.
 */
async function waitForRun(
  rpc: RouterClient<Router>,
  botId: string,
  runId: string,
  cursor: number,
  requestSignal: AbortSignal,
): Promise<boolean> {
  const signal = deadlineSignal(VOICE_TURN_REPLY_WAIT_MS, requestSignal);
  const events = await rpc.threads.subscribe({ botId, cursor }, { signal });
  try {
    for await (const event of events) {
      if (event.runId === runId && SETTLED.has(event.type)) return true;
    }
    return false;
  } catch (error) {
    if (signal.aborted && !requestSignal.aborted) return false;
    throw error;
  } finally {
    await events.return?.();
  }
}

/** The bot's last finished message for `runId` after the person's latest turn. */
function replyTo(thread: ThreadSnapshot, runId: string): ThreadMessage | undefined {
  const messages = thread.messages;
  const turnIndex = messages.findLastIndex((message) => message.role === "user");
  return messages
    .slice(turnIndex + 1)
    .findLast(
      (message) =>
        message.role === "bot" && message.runId === runId && !message.id.startsWith("progress:"),
    );
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
