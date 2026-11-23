import * as z from "zod";

// Also served as `@rakazo/contracts/voice-call` for the web server's proxy, so it imports only zod.

/**
 * A voice device's call with a bot: one WebSocket for the whole conversation. The device sends
 * JSON control frames and, while the person holds to talk, binary frames of 16 kHz mono 16-bit
 * little-endian PCM. The server answers with JSON frames, and each `say` frame is followed by one
 * binary frame holding that utterance's audio in its `mimeType`.
 */
export const VOICE_CALL_PATH = "/api/voice/call";

/** The PCM a device sends while the person holds to talk. */
export const VOICE_CALL_INPUT = { sampleRate: 16_000, channels: 1 } as const;

/** Device to server. */
export const VoiceCallClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    botId: z.string().min(1),
    /** Chosen by the device; the same id `threads.endCall` and the call card use. */
    callId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^:]+$/),
    language: z.string().max(35).optional(),
  }),
  /** The person let go: the audio since the last turn is one turn. */
  z.object({ type: z.literal("end_turn") }),
  /** Stop speaking now and drop what is queued; the person is about to talk. */
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("hang_up") }),
]);
export type VoiceCallClientFrame = z.infer<typeof VoiceCallClientFrameSchema>;

/**
 * Server to device:
 * - `state`: `listening` (ready for a turn), `thinking` (a turn is with the bot), `on_screen`
 *   (the bot needs a code or an approval, which is only given in the app).
 * - `heard`: what a turn said; empty when it held no words, and nothing was sent.
 * - `say`: one utterance to play after those before it; its audio is the next binary frame.
 * - `error`: a turn could not be heard or sent; the call goes on.
 * - `ended`: the call is over, by the person, the bot, or the server.
 */
export type VoiceCallServerFrame =
  | { type: "state"; phase: "listening" | "thinking" | "on_screen" }
  | { type: "heard"; text: string }
  | { type: "say"; text: string; mimeType: string }
  | { type: "error"; message: string }
  | { type: "ended"; reason: "hung_up" | "bot" | "signed_out" | "unavailable" };
