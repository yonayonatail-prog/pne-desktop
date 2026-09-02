export type LegacyReactionInput = "VOICE" | "SILENT" | "NEXT" | "UNKNOWN";
export type DetailedReactionInput = "VOICE_YES" | "VOICE_NO" | "VOICE_OTHER" | "CLICK_SINGLE" | "CLICK_DOUBLE";
export type ReactionInput = LegacyReactionInput | DetailedReactionInput;
export type ReactionDetectionMethod = "LEGACY" | "MANUAL" | "KWS" | "DTW" | "CLICK_PATTERN" | "TIMEOUT";
export type ReactionInputMode = "NORMAL" | "SLEEP_LOOP" | "PUBLIC_SPACE";

/** Recognition metadata only. Audio samples and transcripts must not be persisted here. */
export interface ReactionDetection {
  input: ReactionInput;
  method: ReactionDetectionMethod;
  confidence?: number;
  capturedAt?: string;
}

export interface ReactionInputCapabilities {
  airMicrophone?: boolean;
  contactMicrophone?: boolean;
  dedicatedClickDevice?: boolean;
  boneConductionHeadphones?: boolean;
}

export interface ReactionRuntimeOptions {
  inputMode?: ReactionInputMode;
  detailedInputEnabled?: boolean;
  minimumConfidence?: number;
  capabilities?: ReactionInputCapabilities;
}
export type PlayerMode = "LIVE" | "HISTORY";
export type PlayerStatus = "IDLE" | "PLAYING" | "WAITING_NEXT" | "WAITING_REACTION" | "PAUSED" | "ENDED" | "ERROR";
export type Scalar = string | number | boolean | null;
export type Variables = Record<string, Scalar>;

export interface TextPart { text: string }
export interface NamePart { name_slot_id: string }
export type DisplayPart = TextPart | NamePart;

export interface ClipPart { clip_id: string }
export interface NameClipPart { name_slot_id: string }
export interface GapPart { gap_ms: number }
export type AudioPart = ClipPart | NameClipPart | GapPart;

export interface Condition {
  variable: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "truthy" | "falsy";
  value?: Scalar | Scalar[];
}

export interface Effect {
  variable: string;
  operation: "set" | "increment" | "decrement" | "toggle";
  value?: Scalar;
}

interface NodeBase {
  id: string;
  timeline_ms: number;
  speaker?: string;
  display_sequence?: DisplayPart[];
  audio?: { sequence: AudioPart[] };
  effects?: Effect[];
}

export interface LineNode extends NodeBase {
  type: "line";
  advance: "auto" | "user_next";
  next: string;
}

export interface ReactionNode extends NodeBase {
  type: "reaction_prompt";
  reaction_window: {
    window_ms: number;
    accepted_raw_inputs: ReactionInput[];
    timeout_input: ReactionInput;
    context_mapping: Partial<Record<ReactionInput, string>>;
    branches: Record<string, string>;
    detection?: {
      detailed_inputs?: boolean;
      minimum_confidence?: number;
      allowed_methods?: ReactionDetectionMethod[];
    };
    safety?: {
      important_branch?: boolean;
      confirmations_required?: 1 | 2;
    };
  };
}

export interface BranchNode extends NodeBase {
  type: "branch";
  variants: Array<{ conditions: Condition[]; next: string }>;
  fallback: string;
}

export interface GateNode extends NodeBase {
  type: "gate";
  next: string;
}

export interface EndNode extends NodeBase { type: "end" }
export type ScenarioNode = LineNode | ReactionNode | BranchNode | GateNode | EndNode;

export interface Scenario {
  schema_version: "1.0";
  entry_node: string;
  nodes: ScenarioNode[];
}

export interface NameSlot {
  slot_id: string;
  fallback_clip_id: string;
  fallback_text: string;
  /** Voice profile used to synthesize the player's name for this slot. */
  voice_id?: string;
  /** Fixed form, or "profile" to use the player's selected default form. */
  form?: "bare" | "san" | "kun" | "chan" | "senpai" | "profile";
  pre_gap_ms?: number;
  post_gap_ms?: number;
  crossfade_ms?: number;
}

export interface ResolvedHistoryEntry {
  index: number;
  nodeId: string;
  speaker?: string;
  timelineMs: number;
  displayText: string;
  audioSequence: AudioPart[];
  reactionInput?: ReactionInput;
  rawReactionInput?: ReactionInput;
  reactionMethod?: ReactionDetectionMethod;
  reactionConfidence?: number;
  contextAction?: string;
  nextNodeId?: string;
  committedAt: string;
}

export interface RuntimeSnapshot {
  sessionId: string;
  revision: number;
  mode: PlayerMode;
  status: PlayerStatus;
  currentNodeId: string;
  variables: Variables;
  history: ResolvedHistoryEntry[];
  historyIndex: number | null;
  pendingReaction: boolean;
  pendingReactionConfirmation?: { input: ReactionInput; count: number };
}

export interface Resolvers {
  displayName(slotId: string): string;
  resolveNameAudio(slotId: string): AudioPart[];
}
