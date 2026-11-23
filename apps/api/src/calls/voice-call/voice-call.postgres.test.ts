import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { VoiceCallServerFrame } from "@rakazo/contracts";
import { VOICE_CALL_PATH } from "@rakazo/contracts";
import { asSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { AppHandles } from "../../app.js";
import { createApp } from "../../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

type Received = VoiceCallServerFrame | { type: "audio"; bytes: number };

describe.skipIf(!databaseUrl)("voice device call", () => {
  let dataDir: string;
  let handles: AppHandles;
  let server: ReturnType<typeof serve>;
  let socketUrl: string;
  let bearer: string;
  let botId: string;
  let rpc: (path: string, input?: unknown) => Promise<unknown>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "rakazo-voice-call-"));
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
      phoneCallsEnabled: true,
    });
    await asSystem(handles.prisma).deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", defaultModelProvider: "openrouter", defaultModelId: "test/model" },
      update: {},
    });
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `voice-call-${Date.now()}@example.test`,
        password: "test-password-123",
        name: "Voice call",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    bearer = signup.headers.get("set-auth-token") ?? "";
    expect(bearer).not.toBe("");
    rpc = async (path, input) => {
      const response = await handles.app.request(`/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(input === undefined ? {} : { json: input }),
      });
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      return ((await response.json()) as { json: unknown }).json;
    };
    ({ botId } = (await rpc("onboarding/firstBot")) as { botId: string });
    await rpc("voice/connect", { provider: "scripted", apiKey: "fake-voice-key" });
    server = serve({ fetch: handles.app.fetch, port: 0, hostname: "127.0.0.1" });
    server.on("upgrade", handles.handleUpgrade);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    socketUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${VOICE_CALL_PATH}`;
  }, 120_000);

  afterAll(async () => {
    server?.close();
    await handles?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  /** Opens a call and records every frame the server sends, audio as its size. */
  const connect = (headers: Record<string, string>) => {
    const ws = new WebSocket(socketUrl, { headers });
    const received: Received[] = [];
    ws.on("message", (data, isBinary) => {
      const bytes = data as Buffer;
      received.push(
        isBinary ? { type: "audio", bytes: bytes.byteLength } : JSON.parse(bytes.toString()),
      );
    });
    return { ws, received };
  };

  it("hears a held turn, says the bot's reply, and files the call when the device hangs up", async () => {
    const { ws, received } = connect({ authorization: `Bearer ${bearer}` });
    await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
    ws.send(JSON.stringify({ type: "start", botId, callId: "device-call-1" }));
    // Half a second of silence; the scripted voice hears its fixed transcript in anything.
    ws.send(new Uint8Array(16_000), { binary: true });
    ws.send(JSON.stringify({ type: "end_turn" }));

    await vi.waitFor(
      () => {
        const say = received.findIndex((frame) => frame.type === "say");
        expect(say).toBeGreaterThan(-1);
        expect(received[say + 1]).toMatchObject({ type: "audio" });
        // The device is told it may talk again only once the whole reply has been sent.
        const lastAudio = received.findLastIndex((frame) => frame.type === "audio");
        expect(received.slice(lastAudio)).toContainEqual({ type: "state", phase: "listening" });
      },
      { timeout: 60_000, interval: 50 },
    );
    const heard = received.find((frame) => frame.type === "heard");
    expect(heard).toMatchObject({ type: "heard" });
    const words = heard?.type === "heard" ? heard.text : "";
    expect(words).not.toBe("");

    type Thread = {
      messages: Array<{
        role: string;
        callId?: string;
        blocks: Array<{ kind: string; text?: string }>;
      }>;
    };
    const said = ((await rpc("threads/get", { botId })) as Thread).messages
      .filter((message) => message.role === "user")
      .at(-1);
    expect(said?.blocks).toContainEqual({ kind: "text", text: words });
    expect(said?.callId).toBe("device-call-1");

    ws.send(JSON.stringify({ type: "hang_up" }));
    await vi.waitFor(() => expect(received.at(-1)).toEqual({ type: "ended", reason: "hung_up" }), {
      timeout: 10_000,
      interval: 50,
    });
    // Hanging up files the call's marker in the chat, as an app call does.
    await vi.waitFor(
      async () => {
        const thread = (await rpc("threads/get", { botId })) as Thread;
        expect(
          thread.messages.some((message) => message.blocks.some((b) => b.kind === "voice_call")),
        ).toBe(true);
      },
      { timeout: 30_000, interval: 200 },
    );
  }, 120_000);

  it("turns away a socket signed in only by cookie", async () => {
    const { ws } = connect({ cookie: "better-auth.session_token=anything" });
    const status = await new Promise<number>((resolve) =>
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0)),
    );
    expect(status).toBe(401);
  });
});
