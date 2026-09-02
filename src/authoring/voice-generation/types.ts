import type { VoiceCandidateRecord, VoiceMode, VoiceVariant, TrimPlan } from "../types";

export interface ContextTake {
  variant: VoiceVariant;
  kind: "neutral" | "emotion" | "scene";
  prefix_context: string;
  spoken_text: string;
  suffix_context: string;
  generation_text: string;
  trim_plan: TrimPlan;
}

export interface DialogueGenerationUnit {
  generation_unit_id: string;
  source_line_ids: string[];
  speaker_id: string;
  spoken_text: string;
  takes: [ContextTake, ContextTake, ContextTake];
}

export interface VoiceCandidateAudio extends VoiceCandidateRecord {
  raw_audio?: Blob;
  trimmed_audio?: Blob;
}

export interface VoiceRoundWithAudio {
  round_id: string;
  generation_unit_id: string;
  speaker_id: string;
  voice_preset_id: string;
  voice_mode: VoiceMode;
  reference_fingerprint?: string;
  spoken_text: string;
  candidates: [VoiceCandidateAudio, VoiceCandidateAudio, VoiceCandidateAudio];
  seed_base: number;
  num_steps: 34;
  seconds: number;
  pace_multiplier: number;
  status: "pending" | "running" | "ready" | "selected" | "superseded" | "failed";
  created_at: string;
}

export interface DialogueGenerationProgress {
  stage: "preparing" | "generating" | "trimming" | "ready" | "failed";
  progress: number;
  variant?: VoiceVariant;
  message?: string;
}
