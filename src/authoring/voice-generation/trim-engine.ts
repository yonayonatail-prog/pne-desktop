import type { TrimPlan, TrimStatus } from "../types";

export interface SpeechSegment {
  startMs: number;
  endMs: number;
  threshold: number;
}

export interface TrimResult {
  samples: Float32Array;
  status: TrimStatus;
  warnings: string[];
  segments: SpeechSegment[];
  startMs: number;
  endMs: number;
}

const WINDOW_MS = 10;
const MIN_SPEECH_MS = 80;
const MIN_SILENCE_MS = 80;
const THRESHOLD_DB = -40;
const START_PAD_MS = 30;
const END_PAD_MS = 50;

function dbToAmplitude(db: number): number {
  return 10 ** (db / 20);
}

export function detectSpeechSegments(samples: Float32Array, sampleRate: number): SpeechSegment[] {
  const windowFrames = Math.max(1, Math.round(sampleRate * WINDOW_MS / 1000));
  const minimumSpeechWindows = Math.max(1, Math.ceil(MIN_SPEECH_MS / WINDOW_MS));
  const minimumSilenceWindows = Math.max(1, Math.ceil(MIN_SILENCE_MS / WINDOW_MS));
  const rmsValues: number[] = [];
  let peakRms = 0;

  for (let start = 0; start < samples.length; start += windowFrames) {
    const end = Math.min(samples.length, start + windowFrames);
    let sumSquares = 0;
    for (let index = start; index < end; index += 1) sumSquares += samples[index] * samples[index];
    const rms = Math.sqrt(sumSquares / Math.max(1, end - start));
    rmsValues.push(rms);
    peakRms = Math.max(peakRms, rms);
  }

  const threshold = Math.max(dbToAmplitude(THRESHOLD_DB), peakRms * 0.035);
  const segments: Array<{ start: number; end: number }> = [];
  let speechStart: number | null = null;
  let silenceWindows = 0;
  for (let index = 0; index < rmsValues.length; index += 1) {
    if (rmsValues[index] >= threshold) {
      if (speechStart == null) speechStart = index;
      silenceWindows = 0;
      continue;
    }
    if (speechStart == null) continue;
    silenceWindows += 1;
    if (silenceWindows < minimumSilenceWindows) continue;
    const end = index - silenceWindows + 1;
    if (end - speechStart >= minimumSpeechWindows) segments.push({ start: speechStart, end });
    speechStart = null;
    silenceWindows = 0;
  }
  if (speechStart != null) {
    const end = rmsValues.length;
    if (end - speechStart >= minimumSpeechWindows) segments.push({ start: speechStart, end });
  }

  return segments.map((segment) => ({
    startMs: segment.start * WINDOW_MS,
    endMs: Math.min(samples.length / sampleRate * 1000, segment.end * WINDOW_MS),
    threshold
  }));
}

function clampIndex(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

export function trimAudio(samples: Float32Array, sampleRate: number, plan: TrimPlan): TrimResult {
  const durationMs = samples.length / sampleRate * 1000;
  const segments = detectSpeechSegments(samples, sampleRate);
  const predictedStart = durationMs * plan.predicted_start_ratio;
  const predictedEnd = durationMs * plan.predicted_end_ratio;
  let status: TrimStatus = "ok";
  let startMs = predictedStart;
  let endMs = predictedEnd;
  const warnings: string[] = [];

  if (segments.length >= 3) {
    const target = segments[Math.min(1, segments.length - 1)];
    startMs = target.startMs;
    endMs = target.endMs;
  } else {
    const overlapping = segments.find((segment) => segment.endMs >= predictedStart && segment.startMs <= predictedEnd);
    if (overlapping) {
      startMs = overlapping.startMs;
      endMs = overlapping.endMs;
    } else {
      status = segments.length ? "ratio_fallback" : "silence_not_found";
      warnings.push(segments.length ? "対象台詞の発話境界を特定できず、文字比率で切り出しました" : "発話境界を検出できず、文字比率で切り出しました");
    }
  }

  startMs = Math.max(0, startMs - START_PAD_MS);
  endMs = Math.min(durationMs, Math.max(startMs + 80, endMs + END_PAD_MS));
  const start = clampIndex(startMs / 1000 * sampleRate, 0, Math.max(0, samples.length - 1));
  const end = clampIndex(endMs / 1000 * sampleRate, Math.min(samples.length, start + 1), samples.length);
  return { samples: samples.slice(start, Math.max(start + 1, end)), status, warnings, segments, startMs, endMs };
}

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); writeText(8, "WAVE");
  writeText(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
