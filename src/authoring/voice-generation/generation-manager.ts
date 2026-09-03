import type { VoicePreset } from "../types";
import { buildContextVariants } from "./context-builder";
import { estimateSeconds, FIXED_NUM_STEPS, normalizePaceMultiplier } from "./duration-policy";
import { encodeWav, trimAudio } from "./trim-engine";
import type { DialogueGenerationProgress, DialogueGenerationUnit, VoiceCandidateAudio, VoiceRoundWithAudio } from "./types";

type RawSynthesis = { audio: Float32Array; sampleRate: number; referenceFingerprint?: string };

interface IrodoriDialogueAdapter {
  synthesizeContext(
    text: string,
    referenceUrl: string,
    options: { numSteps: number; seed: number; seconds: number; signal?: AbortSignal; onProgress?: (event: Record<string, unknown>) => void }
  ): Promise<RawSynthesis>;
}

function randomSeed(): number {
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(values);
  else values[0] = Math.floor(Math.random() * 0xffffffff);
  return values[0];
}

let roundSequence = 0;

function makeRoundId(unitId: string): string {
  roundSequence = (roundSequence + 1) % 0x1000000;
  return `round_${unitId.replace(/[^A-Za-z0-9_-]+/g, "_")}_${Date.now().toString(36)}_${roundSequence.toString(36)}`;
}

function errorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return error instanceof Error ? error.message : undefined;
  const value = error as {
    message?: unknown;
    stage?: unknown;
    component?: unknown;
    cause?: { name?: unknown; message?: unknown };
  };
  const detail = [
    typeof value.component === "string" ? `component=${value.component}` : "",
    typeof value.stage === "string" ? `stage=${value.stage}` : "",
    typeof value.cause?.name === "string" ? value.cause.name : "",
    typeof value.cause?.message === "string" ? value.cause.message : typeof value.message === "string" ? value.message : ""
  ].filter(Boolean).join(" / ");
  return detail ? detail.replace(/https?:\/\/[^\s"'<>]+/g, "[URL]").slice(0, 500) : undefined;
}

function assertUsableAudio(samples: Float32Array): void {
  if (samples.length === 0) {
    throw Object.assign(new Error("生成された音声データが空です"), { code: "INVALID_GENERATED_AUDIO" });
  }
  let peak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      throw Object.assign(new Error("生成された音声データに無効な値が含まれています"), { code: "INVALID_GENERATED_AUDIO" });
    }
    peak = Math.max(peak, Math.abs(sample));
  }
  if (peak < 1e-5) {
    throw Object.assign(new Error("生成された音声が無音です。モデルデータを確認してください"), { code: "INVALID_GENERATED_AUDIO" });
  }
}

export interface GenerateRoundInput {
  nodes: Parameters<typeof buildContextVariants>[0];
  nodeId: string;
  preset: VoicePreset;
  referenceUrl: string;
  firstPerson?: string;
  paceMultiplier?: number;
  roundId?: string;
  seedBase?: number;
  signal?: AbortSignal;
  onProgress?: (progress: DialogueGenerationProgress) => void;
}

export class DialogueVoiceGenerator {
  constructor(private readonly adapter: IrodoriDialogueAdapter) {}

  async generateRound(input: GenerateRoundInput): Promise<VoiceRoundWithAudio> {
    if (input.preset.mode !== "reference") {
      throw Object.assign(new Error("このTauri版では参照音声モードのプリセットを使用してください"), { code: "VOICE_PRESET_UNAVAILABLE" });
    }
    if (!input.referenceUrl) {
      throw Object.assign(new Error("参照音声を選択してください"), { code: "VOICE_REFERENCE_MISSING" });
    }
    const unit: DialogueGenerationUnit = buildContextVariants(input.nodes, input.nodeId, { firstPerson: input.firstPerson });
    const paceMultiplier = normalizePaceMultiplier(input.paceMultiplier ?? 1);
    const seconds = estimateSeconds(unit.spoken_text, paceMultiplier);
    const seedBase = input.seedBase ?? randomSeed();
    const roundId = input.roundId ?? makeRoundId(unit.generation_unit_id);
    const candidates: VoiceCandidateAudio[] = [];
    let referenceFingerprint: string | undefined;
    input.onProgress?.({ stage: "preparing", progress: 0, message: "文脈と生成条件を準備しています" });

    for (let index = 0; index < unit.takes.length; index += 1) {
      const take = unit.takes[index];
      const variantProgress = index / unit.takes.length;
      input.onProgress?.({ stage: "generating", progress: variantProgress, variant: take.variant, message: `${take.variant}を生成しています` });
      try {
        const raw = await this.adapter.synthesizeContext(take.generation_text, input.referenceUrl, {
          numSteps: FIXED_NUM_STEPS,
          seed: seedBase,
          seconds: seconds,
          signal: input.signal,
          onProgress: (event) => {
            const rawProgress = Number(event.progress ?? 0);
            if (event.state === "loading-model") {
              input.onProgress?.({
                stage: "preparing",
                progress: Math.max(0, Math.min(0.25, rawProgress * 0.25)),
                message: "Irodoriモデルを読み込んでいます（初回は時間がかかります）"
              });
              return;
            }
            input.onProgress?.({
              stage: "generating",
              progress: 0.25 + Math.min(0.65, (variantProgress + Math.max(0, Math.min(1, rawProgress)) / unit.takes.length) * 0.65),
              variant: take.variant,
              message: `${take.variant}を生成しています`
            });
          }
        });
        assertUsableAudio(raw.audio);
        referenceFingerprint ||= raw.referenceFingerprint;
        input.onProgress?.({ stage: "trimming", progress: 0.9 + variantProgress * 0.08, variant: take.variant, message: `${take.variant}をTrimしています` });
        const trimmed = trimAudio(raw.audio, raw.sampleRate, take.trim_plan);
        candidates.push({
          candidate_id: `${roundId}_${take.variant}`,
          variant: take.variant,
          status: "trimmed",
          raw_audio_key: `${roundId}/${take.variant}.raw.wav`,
          trimmed_audio_key: `${roundId}/${take.variant}.trimmed.wav`,
          raw_audio: encodeWav(raw.audio, raw.sampleRate),
          trimmed_audio: encodeWav(trimmed.samples, raw.sampleRate),
          duration_ms: Math.round(trimmed.samples.length / raw.sampleRate * 1000),
          seed: seedBase,
          num_steps: FIXED_NUM_STEPS,
          seconds,
          trim_status: trimmed.status,
          warnings: trimmed.warnings
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "GENERATION_FAILED";
        const detail = errorDetail(error);
        console.error("[VoiceGeneration] candidate failed", { variant: take.variant, code, detail, error });
        candidates.push({
          candidate_id: `${roundId}_${take.variant}`,
          variant: take.variant,
          status: "failed",
          seed: seedBase,
          num_steps: FIXED_NUM_STEPS,
          seconds,
          warnings: [],
          error_code: code,
          error_detail: detail
        });
      }
    }

    const successCount = candidates.filter((candidate) => candidate.status === "trimmed").length;
    const round: VoiceRoundWithAudio = {
      round_id: roundId,
      generation_unit_id: unit.generation_unit_id,
      speaker_id: unit.speaker_id,
      voice_preset_id: input.preset.voice_preset_id,
      voice_mode: input.preset.mode,
      reference_fingerprint: referenceFingerprint,
      spoken_text: unit.spoken_text,
      candidates: candidates as [VoiceCandidateAudio, VoiceCandidateAudio, VoiceCandidateAudio],
      seed_base: seedBase,
      num_steps: FIXED_NUM_STEPS,
      seconds,
      pace_multiplier: paceMultiplier,
      status: successCount === candidates.length ? "ready" : successCount ? "ready" : "failed",
      created_at: new Date().toISOString()
    };
    input.onProgress?.({ stage: round.status === "ready" ? "ready" : "failed", progress: 1, message: round.status === "ready" ? "A/B/Cの生成が完了しました" : "A/B/Cを生成できませんでした" });
    return round;
  }
}
