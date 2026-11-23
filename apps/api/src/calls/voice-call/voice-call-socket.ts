import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Actor } from "@rakazo/contracts";
import { VOICE_CALL_PATH, VoiceCallClientFrameSchema } from "@rakazo/contracts/voice-call";
import { getLogger } from "@rakazo/logging";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { VoiceCall, VoiceCallDeps } from "./voice-call-session.js";
import { startVoiceCall } from "./voice-call-session.js";

/** Control frames are small; audio arrives in short chunks while the person holds to talk. */
const MAX_FRAME_BYTES = 256 * 1024;
/** A socket that answers no ping in this long is gone, and its call ends. */
const PING_INTERVAL_MS = 30_000;
/** The device names its call right after connecting. */
const START_TIMEOUT_MS = 10_000;

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

type RequestSession = (request: Request) => Promise<{ actor: Actor; sessionId: string } | null>;

/**
 * Upgrades for `GET /api/voice/call`: a signed-in voice device's call with one of its bots, on
 * deployments with calls on. Only a bearer token signs a call in. A browser would send its
 * cookie to any site's socket, so cookies are never read here. Other upgrades go to `others`.
 */
export function createVoiceCallSockets(
  deps: VoiceCallDeps & {
    env: VoiceCallDeps["env"] & { phoneCallsEnabled: boolean };
    requestSession: RequestSession;
  },
  others?: UpgradeHandler,
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const calls = new Set<VoiceCall>();

  const attach = (ws: WebSocket, session: { actor: Actor; sessionId: string }) => {
    let call: VoiceCall | null = null;
    let alive = true;
    const startTimer = setTimeout(() => ws.close(1008, "No call started"), START_TIMEOUT_MS);
    const pinger = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_INTERVAL_MS);
    pinger.unref();
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        call?.hear(new Uint8Array(rawBytes(data)));
        return;
      }
      const frame = VoiceCallClientFrameSchema.safeParse(parseJson(rawBytes(data).toString()));
      if (!frame.success) return ws.close(1008, "Invalid frame");
      const message = frame.data;
      if (message.type === "start") {
        if (call) return;
        clearTimeout(startTimer);
        call = startVoiceCall(
          deps,
          { ...session, botId: message.botId, callId: message.callId, language: message.language },
          {
            send: (out) => ws.send(JSON.stringify(out)),
            sendAudio: (bytes) => ws.send(bytes, { binary: true }),
            close: () => ws.close(1000),
          },
        );
        calls.add(call);
      } else if (message.type === "end_turn") call?.endTurn();
      else if (message.type === "stop") call?.stop();
      else call?.hangUp("hung_up");
    });
    // An oversized or malformed frame must end this call, never crash the process.
    ws.on("error", (error) => {
      getLogger().warn("voice call socket error", { error });
      ws.terminate();
    });
    ws.on("close", () => {
      clearTimeout(startTimer);
      clearInterval(pinger);
      if (!call) return;
      calls.delete(call);
      call.hangUp("hung_up");
    });
  };

  return {
    handleUpgrade: ((request, socket, head) => {
      const reject = (status: number, text: string) =>
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      const path = new URL(request.url ?? "/", "http://api.invalid").pathname;
      if (path !== VOICE_CALL_PATH || !deps.env.phoneCallsEnabled) {
        return others ? others(request, socket, head) : reject(404, "Not Found");
      }
      const onError = (error: Error) => getLogger().warn("voice call upgrade error", { error });
      socket.on("error", onError);
      const authorization = request.headers.authorization;
      if (!authorization?.toLowerCase().startsWith("bearer ")) return reject(401, "Unauthorized");
      const headers = new Headers({ authorization });
      const spaceId = request.headers["x-rakazo-space-id"];
      if (typeof spaceId === "string") headers.set("x-rakazo-space-id", spaceId);
      void deps
        .requestSession(new Request(new URL(VOICE_CALL_PATH, "http://voice.invalid"), { headers }))
        .then((session) => {
          if (!session) return reject(401, "Unauthorized");
          socket.off("error", onError);
          wss.handleUpgrade(request, socket, head, (ws) => attach(ws, session));
        })
        .catch((error) => {
          getLogger().error("voice call upgrade failed", error);
          reject(500, "Internal Server Error");
        });
    }) satisfies UpgradeHandler,
    /** Ends every call on this process, as when it stops. */
    close() {
      for (const call of calls) call.hangUp("unavailable");
      calls.clear();
      wss.close();
    },
  };
}

function rawBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
