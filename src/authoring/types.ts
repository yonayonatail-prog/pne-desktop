export type AuthoringTab = "characters" | "flow" | "script";
export type AuthoringNodeType = "start" | "normal" | "reaction" | "branch" | "end" | "reaction_prompt" | "reaction_branch" | "join";
export type VoiceMode = "reference" | "voice_design";
export type VoiceVariant = "A" | "B" | "C";
export type VoiceCandidateStatus = "pending" | "generating" | "trimmed" | "failed";
export type GenerationRoundStatus = "pending" | "running" | "ready" | "selected" | "superseded" | "failed";
export type TrimStatus = "ok" | "ratio_fallback" | "silence_not_found" | "invalid_audio";

export interface VoicePreset {
  voice_preset_id: string;
  label: string;
  group: string;
  tags: string[];
  mode: VoiceMode;
  model_id: string;
  preview_audio?: string;
  reference_audio?: string;
  voice_design_caption?: string;
  reference_version?: string;
  authorization_id?: string;
}

export interface AuthoringVoiceProfile {
  voice_id: string;
  voice_preset_id?: string;
  reference_audio?: string;
  reference_version?: string;
  enabled?: boolean;
}

export interface TrimPlan {
  enabled: boolean;
  prefix_chars: number;
  spoken_chars: number;
  suffix_chars: number;
  total_chars: number;
  predicted_start_ratio: number;
  predicted_end_ratio: number;
}

export interface VoiceCandidateRecord {
  candidate_id: string;
  variant: VoiceVariant;
  status: VoiceCandidateStatus;
  raw_audio_key?: string;
  trimmed_audio_key?: string;
  duration_ms?: number;
  seed: number;
  num_steps: 34;
  seconds: number;
  trim_status?: TrimStatus;
  warnings: string[];
  error_code?: string;
  error_detail?: string;
}

export interface GenerationRoundRecord {
  round_id: string;
  generation_unit_id: string;
  speaker_id: string;
  voice_preset_id: string;
  voice_mode: VoiceMode;
  reference_fingerprint?: string;
  spoken_text: string;
  candidates: [VoiceCandidateRecord, VoiceCandidateRecord, VoiceCandidateRecord];
  seed_base: number;
  num_steps: 34;
  seconds: number;
  pace_multiplier: number;
  status: GenerationRoundStatus;
  created_at: string;
}

export interface GenerationUnitRecord {
  generation_unit_id: string;
  source_line_ids: string[];
  selected_round_id?: string;
  selected_candidate_id?: string;
  rounds: GenerationRoundRecord[];
}

export interface VoiceGenerationManifest {
  manifest_version: "1.0.0";
  project_id: string;
  model_id: string;
  num_steps: 34;
  units: GenerationUnitRecord[];
  updated_at: string;
}

export interface AuthoringProfile {
  role?: string;
  public_face?: string;
  hidden_truth?: string;
  desire?: string;
  fear?: string;
  core_wound?: string;
  relationship_axis?: string;
  notes?: string;
}

export interface AuthoringCharacter {
  character_id: string;
  name: string;
  color?: string;
  voice_preset_id?: string;
  profile: AuthoringProfile;
}

export interface TimelineBeat {
  phase: string;
  label: string;
  key_event: string;
  inner_state?: string;
}

export interface CharacterTimeline {
  character_id: string;
  beats: TimelineBeat[];
}

export interface ExperienceRoute {
  route_id: string;
  kind: "main" | "branch";
  label: string;
  entry_unit_id: string;
  parent_route_id?: string;
  merge_unit_id?: string;
}

export interface ExperienceUnit {
  unit_id: string;
  route_id: string;
  order: number;
  unit: string;
  viewer_state_start: string;
  viewer_state_end: string;
  inversion: string;
  emotional_peak?: string;
  complicity_trigger?: string;
  linked?: string[];
}

export interface ExperienceLink {
  link_id: string;
  from_unit_id: string;
  to_unit_id: string;
  type: "main" | "choice" | "condition" | "micro_branch" | "merge";
  label?: string;
  choice_id?: string;
  condition_id?: string;
}

export interface StateVariable {
  key: string;
  type: "integer" | "number";
  initial: number;
  min: number;
  max: number;
}

export interface StateFlag {
  key: string;
  type: "boolean";
  initial: boolean;
}

export interface AuthoringNode {
  id: string;
  node_id?: string;
  source_unit_id?: string;
  chapter?: string;
  type: AuthoringNodeType;
  purpose?: string;
  player_experience?: string;
  speaker?: string;
  text: string;
  next?: string | null;
  next_ids?: string[];
  performance?: Record<string, string | number>;
  audio?: Record<string, unknown>;
  mapped_action?: string;
  state_updates?: Record<string, unknown>;
  memory_updates?: Record<string, unknown>;
  text_variants?: Array<{ when: string; text: string }>;
  reaction_window?: {
    window_ms: number;
    accepted_raw_inputs?: string[];
    branches: Partial<Record<"VOICE" | "SILENT" | "UNKNOWN", string>> & Record<string, string>;
  };
}

export interface AuthoringPack {
  format: "pne_statekit_pack";
  schema_version: string;
  meta: { title: string; version: string; author?: string; description?: string };
  entry_node: string;
  characters: AuthoringCharacter[];
  character_timelines: CharacterTimeline[];
  experience_routes: ExperienceRoute[];
  experience_timeline: ExperienceUnit[];
  experience_links: ExperienceLink[];
  mislead_foreshadow_registry: Array<{ id: string; type: "mislead" | "foreshadow"; seed_unit_ids: string[]; payoff_unit_ids: string[]; seed_description: string; payoff_description: string }>;
  state_schema: { variables: StateVariable[]; flags: StateFlag[] };
  pne_rules: { input_types: string[]; unknown_behavior: string; reaction_loop_max_turns: number };
  runtime_state: Record<string, unknown>;
  nodes: AuthoringNode[];
  voice_profiles?: AuthoringVoiceProfile[];
  voice_generation?: VoiceGenerationManifest;
}

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
  nodeId?: string;
}
