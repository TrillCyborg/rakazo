import type { VoiceTranscription, VoiceTranscriptionStream } from "@rakazo/adapter-kit";
import type { RawData } from "ws";
import WebSocket from "ws";

/** How long the text may take once the audio has ended, about what transcribing it whole takes. */
export const LIVE_TRANSCRIPT_TIMEOUT_MS = 1_500;

type Settle = { resolve(text: VoiceTranscription): void; reject(error: Error): void };

/**
 * One xAI streaming transcription over a WebSocket. Audio written before the server is ready
 * waits; ending the audio asks for the final transcript, which the server sends once.
 */
export function openXaiLiveTranscription(
  url: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): VoiceTranscriptionStream {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${apiKey}` } });
  const waiting: Uint8Array[] = [];
  /** Text the server finalized as it went, in case its final event leaves the text out. */
  const finals: string[] = [];
  let ready = false;
  let closed = false;
  let failure: Error | null = null;
  let result: Promise<VoiceTranscription> | null = null;
  let settle: Settle | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const end = () => {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
  };

  const fail = (error: Error) => {
    if (closed) return;
    end();
    failure = error;
    settle?.reject(error);
    socket.terminate();
  };

  const aborted = () => {
    const error = new Error("xAI live transcription was cancelled");
    error.name = "AbortError";
    fail(error);
  };

  const sendWaiting = () => {
    for (const chunk of waiting.splice(0)) socket.send(chunk);
  };

  const endAudio = () => {
    sendWaiting();
    socket.send(JSON.stringify({ type: "audio.done" }));
  };

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary || closed) return;
    const event = parseEvent(data);
    if (event?.type === "transcript.created") {
      ready = true;
      if (result) endAudio();
      else sendWaiting();
    } else if (event?.type === "transcript.partial") {
      if (event.is_final === true && typeof event.text === "string") finals.push(event.text.trim());
    } else if (event?.type === "transcript.done") {
      end();
      const text = typeof event.text === "string" ? event.text : finals.join(" ");
      const duration = event.duration;
      settle?.resolve({
        text: text.trim(),
        ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0
          ? { usage: { model, unit: "seconds" as const, units: duration } }
          : {}),
      });
      socket.close();
    } else if (event?.type === "error") {
      const detail = typeof event.message === "string" ? `: ${event.message.slice(0, 200)}` : "";
      fail(new Error(`xAI live transcription failed${detail}`));
    }
  });
  socket.on("error", (error) => fail(error));
  socket.on("close", () => fail(new Error("xAI live transcription closed before its text")));
  if (signal?.aborted) aborted();
  else signal?.addEventListener("abort", aborted, { once: true });

  return {
    write(audio) {
      if (closed || result) return;
      if (ready) socket.send(audio);
      else waiting.push(audio);
    },
    finish() {
      if (failure) return Promise.reject(failure);
      result ??= new Promise<VoiceTranscription>((resolve, reject) => {
        settle = { resolve, reject };
        timer = setTimeout(
          () => fail(new Error("xAI live transcription timed out")),
          LIVE_TRANSCRIPT_TIMEOUT_MS,
        );
        if (ready) endAudio();
      });
      return result;
    },
    close() {
      fail(new Error("xAI live transcription was closed"));
    },
  };
}

function parseEvent(data: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data.toString());
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
