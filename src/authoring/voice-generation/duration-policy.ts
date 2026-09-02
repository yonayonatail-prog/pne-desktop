export const FIXED_NUM_STEPS = 34 as const;
export const MIN_SECONDS = 10;
export const MAX_SECONDS = 45;
export const DEFAULT_CHARS_PER_SECOND = 4;
export const DEFAULT_MARGIN_RATIO = 1.22;
export const DEFAULT_MARGIN_SECONDS = 1.8;

export const PACE_OPTIONS = [
  { id: "standard", label: "標準", multiplier: 1 },
  { id: "slow", label: "少しゆっくり", multiplier: 1.08 },
  { id: "slower", label: "ゆっくり", multiplier: 1.16 }
] as const;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizePaceMultiplier(value: number): number {
  return clamp(Number.isFinite(value) ? value : 1, 0.9, 1.2);
}

export function spokenCharacterCount(text: string): number {
  return [...String(text || "").replace(/\s+/g, "")].length;
}

export function estimateSeconds(text: string, paceMultiplier = 1): number {
  const base = spokenCharacterCount(text) / DEFAULT_CHARS_PER_SECOND * DEFAULT_MARGIN_RATIO + DEFAULT_MARGIN_SECONDS;
  return clamp(Math.round(base * normalizePaceMultiplier(paceMultiplier)), MIN_SECONDS, MAX_SECONDS);
}
