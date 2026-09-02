import type {
  LegacyReactionInput,
  ReactionDetection,
  ReactionDetectionMethod,
  ReactionInput,
  ReactionInputCapabilities,
  ReactionNode,
  ReactionRuntimeOptions
} from "./types";

export interface NormalizedReaction {
  rawInput: ReactionInput;
  input: ReactionInput;
  method: ReactionDetectionMethod;
  confidence?: number;
  reason: "EXACT" | "COMPATIBILITY" | "LOW_CONFIDENCE" | "MODE_BLOCKED" | "METHOD_BLOCKED" | "DEVICE_UNAVAILABLE" | "UNSUPPORTED";
}

export const isVoiceReaction = (input: ReactionInput): boolean =>
  input === "VOICE" || input === "VOICE_YES" || input === "VOICE_NO" || input === "VOICE_OTHER";

export const isClickReaction = (input: ReactionInput): boolean => input === "CLICK_SINGLE" || input === "CLICK_DOUBLE";

export function toLegacyReactionInput(input: ReactionInput): LegacyReactionInput {
  if (isVoiceReaction(input) || isClickReaction(input)) return "VOICE";
  if (input === "SILENT" || input === "NEXT") return input;
  return "UNKNOWN";
}

/** Bone-conduction output alone does not provide a usable click-input sensor. */
export function canDetectClicks(capabilities: ReactionInputCapabilities = {}): boolean {
  return Boolean(capabilities.airMicrophone || capabilities.contactMicrophone || capabilities.dedicatedClickDevice);
}

export function preferredDetectionMethod(kind: "FIXED_KEYWORD" | "USER_TEMPLATE" | "CLICK_PATTERN"): ReactionDetectionMethod {
  if (kind === "FIXED_KEYWORD") return "KWS";
  if (kind === "USER_TEMPLATE") return "DTW";
  return "CLICK_PATTERN";
}

const asDetection = (value: ReactionInput | ReactionDetection): ReactionDetection =>
  typeof value === "string" ? { input: value, method: "LEGACY" } : value;

export function normalizeReactionInput(
  value: ReactionInput | ReactionDetection,
  window: ReactionNode["reaction_window"],
  runtime: ReactionRuntimeOptions = {}
): NormalizedReaction {
  const detection = asDetection(value);
  const minimumConfidence = window.detection?.minimum_confidence ?? runtime.minimumConfidence ?? 0;
  const detailedEnabled = window.detection?.detailed_inputs ?? runtime.detailedInputEnabled ?? true;
  const result = (input: ReactionInput, reason: NormalizedReaction["reason"]): NormalizedReaction => ({
    rawInput: detection.input, input, method: detection.method, confidence: detection.confidence, reason
  });

  if (runtime.inputMode === "PUBLIC_SPACE" && isVoiceReaction(detection.input)) return result("UNKNOWN", "MODE_BLOCKED");
  if (detection.confidence !== undefined && detection.confidence < minimumConfidence) return result("UNKNOWN", "LOW_CONFIDENCE");
  if (window.detection?.allowed_methods && !window.detection.allowed_methods.includes(detection.method)) return result("UNKNOWN", "METHOD_BLOCKED");
  if (isClickReaction(detection.input) && detection.method !== "MANUAL" && !canDetectClicks(runtime.capabilities)) {
    return result("UNKNOWN", "DEVICE_UNAVAILABLE");
  }

  const candidate = detailedEnabled ? detection.input : toLegacyReactionInput(detection.input);
  if (window.accepted_raw_inputs.includes(candidate)) return result(candidate, candidate === detection.input ? "EXACT" : "COMPATIBILITY");
  const compatibility = toLegacyReactionInput(candidate);
  if (window.accepted_raw_inputs.includes(compatibility)) return result(compatibility, "COMPATIBILITY");
  return result("UNKNOWN", "UNSUPPORTED");
}
