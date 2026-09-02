// The runtime is audited plain ESM and intentionally shares the existing
// browser model loader with the name-voice feature.
// @ts-expect-error The vendored runtime has no TypeScript declaration.
import * as bundledNameVoiceModule from "../name-voice/pne-name-voice.mjs";
import { DialogueVoiceGenerator } from "../authoring/voice-generation/generation-manager";

interface DialogueRuntimeModule {
  IrodoriAdapter: new () => {
    synthesizeContext: (
      text: string,
      referenceUrl: string,
      options: { numSteps: number; seed: number; seconds: number; signal?: AbortSignal; onProgress?: (event: Record<string, unknown>) => void }
    ) => Promise<{ audio: Float32Array; sampleRate: number; referenceFingerprint?: string }>;
  };
}

let generator: DialogueVoiceGenerator | null = null;

export function getDialogueVoiceGenerator(): DialogueVoiceGenerator {
  if (!generator) {
    const runtime = bundledNameVoiceModule as unknown as DialogueRuntimeModule;
    generator = new DialogueVoiceGenerator(new runtime.IrodoriAdapter());
  }
  return generator;
}
