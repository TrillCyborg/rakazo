import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { openXaiLiveTranscription } from "./xai-live-transcription.js";

type Server = { url: string; received: (Buffer | string)[]; authorization?: string };

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A stand-in for the transcription socket: `reply` answers each client message. */
async function serve(reply: (socket: WebSocket, message: Buffer | string) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  servers.push(wss);
  await new Promise((resolve) => wss.once("listening", resolve));
  const server: Server = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/stt`,
    received: [],
  };
  wss.on("connection", (socket, request) => {
    server.authorization = request.headers.authorization;
    socket.send(JSON.stringify({ type: "transcript.created" }));
    socket.on("message", (data: Buffer, isBinary) => {
      const message = isBinary ? data : data.toString();
      server.received.push(message);
      reply(socket, message);
    });
  });
  return server;
}

const isAudioDone = (message: Buffer | string) =>
  typeof message === "string" && JSON.parse(message).type === "audio.done";

describe("openXaiLiveTranscription", () => {
  it("sends audio written before the server is ready, then its end, and returns the text", async () => {
    const server = await serve((socket, message) => {
      if (!isAudioDone(message)) return;
      socket.send(
        JSON.stringify({ type: "transcript.done", text: " Hello there. ", duration: 1.5 }),
      );
    });

    const stream = openXaiLiveTranscription(server.url, "xai-key", "stt-model");
    stream.write(new Uint8Array([1, 2]));
    stream.write(new Uint8Array([3, 4]));

    await expect(stream.finish()).resolves.toEqual({
      text: "Hello there.",
      usage: { model: "stt-model", unit: "seconds", units: 1.5 },
    });
    expect(server.authorization).toBe("Bearer xai-key");
    expect(server.received.map((message) => Buffer.from(message).toString("hex"))).toEqual([
      "0102",
      "0304",
      Buffer.from(JSON.stringify({ type: "audio.done" })).toString("hex"),
    ]);
  });

  it("joins the text finalized along the way when the final event carries none", async () => {
    const server = await serve((socket, message) => {
      if (!isAudioDone(message)) return;
      socket.send(JSON.stringify({ type: "transcript.partial", text: "Hel", is_final: false }));
      socket.send(JSON.stringify({ type: "transcript.partial", text: "Hello.", is_final: true }));
      socket.send(JSON.stringify({ type: "transcript.partial", text: "Bye.", is_final: true }));
      socket.send(JSON.stringify({ type: "transcript.done", text: "", duration: 2 }));
    });

    const stream = openXaiLiveTranscription(server.url, "xai-key", "stt-model");
    stream.write(new Uint8Array([1]));

    await expect(stream.finish()).resolves.toMatchObject({ text: "Hello. Bye." });
  });

  it("adds the text the final event finalizes to what came before it", async () => {
    const server = await serve((socket, message) => {
      if (!isAudioDone(message)) return;
      socket.send(JSON.stringify({ type: "transcript.partial", text: "Hello.", is_final: true }));
      socket.send(JSON.stringify({ type: "transcript.done", text: "Bye.", duration: 2 }));
    });

    const stream = openXaiLiveTranscription(server.url, "xai-key", "stt-model");

    await expect(stream.finish()).resolves.toMatchObject({ text: "Hello. Bye." });
  });

  it("rejects when the server reports an error", async () => {
    const server = await serve((socket, message) => {
      if (isAudioDone(message))
        socket.send(JSON.stringify({ type: "error", message: "bad audio" }));
    });

    const stream = openXaiLiveTranscription(server.url, "xai-key", "stt-model");

    await expect(stream.finish()).rejects.toThrow("bad audio");
  });

  it("rejects when the socket closes before the text", async () => {
    const server = await serve((socket, message) => {
      if (isAudioDone(message)) socket.close();
    });

    const stream = openXaiLiveTranscription(server.url, "xai-key", "stt-model");

    await expect(stream.finish()).rejects.toThrow("closed before its text");
  });
});
