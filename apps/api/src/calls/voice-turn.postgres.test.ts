import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceTurnResult } from "@rakazo/contracts";
import { asSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "answers a spoken turn with the bot's reply, kept in its thread",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-voice-turn-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
    });
    try {
      await asSystem(handles.prisma).deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", defaultModelProvider: "openrouter", defaultModelId: "test/model" },
        update: {},
      });
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `voice-turn-${Date.now()}@example.test`,
          password: "test-password-123",
          name: "Voice turn",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const headers = { "content-type": "application/json", origin, cookie };
      const rpc = async (path: string, input?: unknown) => {
        const response = await handles.app.request(`/rpc/${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(input === undefined ? {} : { json: input }),
        });
        expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
        return ((await response.json()) as { json: unknown }).json;
      };
      const { botId } = (await rpc("onboarding/firstBot")) as { botId: string };
      await rpc("voice/connect", { provider: "scripted", apiKey: "fake-voice-key" });

      const turn = await handles.app.request("/api/voice/turn", {
        method: "POST",
        headers,
        body: JSON.stringify({
          botId,
          callId: "device-call-1",
          audioBase64: Buffer.from("fake recording").toString("base64"),
          mimeType: "audio/wav",
        }),
      });
      expect(turn.status, await turn.clone().text()).toBe(200);
      const result = (await turn.json()) as VoiceTurnResult;
      expect(result.status).toBe("replied");
      expect(result.say.length).toBeGreaterThan(0);

      const thread = (await rpc("threads/get", { botId })) as {
        messages: Array<{
          role: string;
          callId?: string;
          blocks: Array<{ kind: string; text?: string }>;
        }>;
      };
      const said = thread.messages.filter((message) => message.role === "user").at(-1);
      expect(said?.blocks).toContainEqual({ kind: "text", text: result.heard });
      expect(said?.callId).toBe("device-call-1");
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);
