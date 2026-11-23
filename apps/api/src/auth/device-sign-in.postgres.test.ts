import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSystem } from "@rakazo/db";
import { expect, it } from "vitest";
import { createApp } from "../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

it.skipIf(!databaseUrl)(
  "signs a device in with a code that a signed-in person approves",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-device-sign-in-"));
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
      const auth = (path: string, init: { body?: unknown; headers?: Record<string, string> }) =>
        handles.app.request(`/api/auth${path}`, {
          method: init.body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json", origin, ...init.headers },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      const email = `device-sign-in-${Date.now()}@example.test`;
      const signup = await auth("/sign-up/email", {
        body: { email, password: "test-password-123", name: "Device owner" },
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");

      const unknown = await auth("/device/code", { body: { client_id: "unknown-device" } });
      expect(unknown.status).toBe(400);

      const requested = await auth("/device/code", { body: { client_id: "voice-device" } });
      expect(requested.status).toBe(200);
      const code = (await requested.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
      };
      expect(code.verification_uri).toBe(`${origin}/device`);
      const redeem = () =>
        auth("/device/token", {
          body: {
            grant_type: DEVICE_GRANT,
            device_code: code.device_code,
            client_id: "voice-device",
          },
        });

      const pending = await redeem();
      expect(pending.status).toBe(400);
      expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

      // Typing the code on the web claims it for the signed-in person, who then approves it.
      const claimed = await auth(`/device?user_code=${encodeURIComponent(code.user_code)}`, {
        headers: { cookie },
      });
      expect(await claimed.json()).toMatchObject({ status: "pending", client_id: "voice-device" });
      const approved = await auth("/device/approve", {
        body: { userCode: code.user_code },
        headers: { cookie },
      });
      expect(approved.status).toBe(200);

      // A device waits the polling interval between tries.
      await asSystem(handles.prisma).deviceCode.updateMany({
        where: { deviceCode: code.device_code },
        data: { lastPolledAt: new Date(Date.now() - 60_000) },
      });
      const redeemed = await redeem();
      expect(redeemed.status).toBe(200);
      const { access_token: bearer } = (await redeemed.json()) as { access_token: string };
      const me = await handles.app.request("/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ json: {} }),
      });
      expect(me.status).toBe(200);
      expect(JSON.stringify(await me.json())).toContain(email);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  60_000,
);
