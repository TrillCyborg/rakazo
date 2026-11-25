import type { VoiceTranscriptionStream } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { VoiceDeps } from "../voice.js";
import { loadDefaultVoiceCredential, voiceContext, voiceProviderFor } from "../voice.js";

/**
 * A live transcription of audio as it is heard, with the account's own voice connection. Null
 * when its provider has none, or the deployment pays for the speech: that is admitted and settled
 * per recording, so the caller transcribes the recording whole instead.
 */
export async function openVoiceTranscription(
  deps: VoiceDeps,
  actor: Actor,
  input: { sampleRate: number; channels: number; language?: string; signal?: AbortSignal },
): Promise<VoiceTranscriptionStream | null> {
  input.signal?.throwIfAborted();
  const loaded = await loadDefaultVoiceCredential(
    deps,
    actor,
    undefined,
    input.signal,
    "transcribe",
  );
  if (!loaded || loaded.deployment) return null;
  const provider = await voiceProviderFor(deps, loaded.cred.provider);
  if (!provider.transcribeStream) return null;
  return provider.transcribeStream(
    {
      sampleRate: input.sampleRate,
      channels: input.channels,
      language: input.language,
      apiKey: loaded.apiKey,
      signal: input.signal,
    },
    voiceContext(actor, input.signal),
  );
}
