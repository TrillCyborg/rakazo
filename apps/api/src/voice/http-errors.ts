import { ORPCError } from "@orpc/server";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { NoVoiceConfigured, VoiceProviderRefusedError } from "@rakazo/adapters";
import type { VoiceAccountErrorCode } from "@rakazo/contracts";
import { ConnectionSetupError } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { getLogContext, getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { clientErrorStatus } from "../client-error-status.js";

/** Spent credit is 402; any other refusal is 403, never 401, which clients read as a lost session. */
export function voiceAccountErrorStatus(code: VoiceAccountErrorCode | undefined) {
  return code === "VOICE_OUT_OF_CREDIT" ? 402 : 403;
}

export function voiceHttpError(c: Context, error: unknown) {
  const { body, status } = voiceErrorReply(error, c.req.path);
  return c.json(body, status);
}

/**
 * What a voice request that failed tells its caller, and with what status. The message is safe
 * to show: provider text never reaches it.
 */
export function voiceErrorReply(
  error: unknown,
  route: string,
): { body: { error: string; code?: string }; status: ContentfulStatusCode } {
  if (error instanceof IsolationError) {
    return { body: { error: "Resource not found" }, status: 404 };
  }
  if (error instanceof NoVoiceConfigured) {
    return { body: { error: error.message }, status: 409 };
  }
  if (error instanceof ClientError) {
    const status = clientErrorStatus(error.kind);
    // An outage the caller is told to wait out is still a failure to look at, unless its thrower
    // logged it as expected.
    if (status >= 500 && !getLogContext()["error.expected"]) {
      getLogger().error("voice request unavailable", {
        route,
        reason: error.cause instanceof Error ? error.cause.name : error.kind,
      });
    }
    return {
      body: { error: error.message, ...(error.code !== error.kind ? { code: error.code } : {}) },
      status: status,
    };
  }
  if (error instanceof ORPCError) {
    const code = String(error.code ?? "BAD_REQUEST");
    const status =
      code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
    return { body: { error: error.message }, status: status };
  }
  if (error instanceof VoiceAccountError) {
    getLogger().warn("voice provider account rejected the request", {
      route,
      reason: error.code ?? error.name,
    });
    return {
      body: { error: error.message, code: error.code },
      status: voiceAccountErrorStatus(error.code),
    };
  }
  const message = "Voice request failed. Try again.";
  // Log only the error kind; provider response text can contain credentials.
  getLogger().warn("voice request failed", {
    route,
    reason: error instanceof Error ? error.name : "unknown",
    ...(error instanceof VoiceProviderRefusedError
      ? { "provider.status": error.status, "provider.reason": error.reason }
      : {}),
  });
  if (isVoiceProviderFailure(error)) markExpectedFailure();
  return { body: { error: message }, status: 502 };
}

/** Voice adapters raise plain errors for provider refusals and setup problems; anything else is a bug. */
export function isVoiceProviderFailure(error: unknown) {
  return (
    error instanceof Error &&
    (Object.getPrototypeOf(error) === Error.prototype ||
      error instanceof VoiceProviderRefusedError ||
      error instanceof ConnectionSetupError ||
      error.name === "AbortError" ||
      error.name === "TimeoutError")
  );
}
