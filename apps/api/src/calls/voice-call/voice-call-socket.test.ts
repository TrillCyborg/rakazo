import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { expect, it, vi } from "vitest";
import type { VoiceCallDeps } from "./voice-call-session.js";
import { createVoiceCallSockets } from "./voice-call-socket.js";

it("hands every other upgrade, and the call path while calls are off, to the next listener", () => {
  const others = vi.fn();
  const sockets = (phoneCallsEnabled: boolean) =>
    createVoiceCallSockets(
      {
        env: { phoneCallsEnabled },
        requestSession: vi.fn(),
      } as unknown as VoiceCallDeps & {
        env: { phoneCallsEnabled: boolean };
        requestSession: () => Promise<null>;
      },
      others,
    );
  const request = (url: string) => ({ url, headers: {} }) as IncomingMessage;
  const socket = { on: vi.fn(), end: vi.fn() } as unknown as Duplex;

  sockets(true).handleUpgrade(request("/api/devices/connect"), socket, Buffer.alloc(0));
  sockets(false).handleUpgrade(request("/api/voice/call"), socket, Buffer.alloc(0));

  expect(others).toHaveBeenCalledTimes(2);
  expect(socket.end).not.toHaveBeenCalled();
});
