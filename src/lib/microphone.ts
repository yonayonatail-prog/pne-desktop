export function rmsFromTimeDomain(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  return Math.sqrt(sumOfSquares / samples.length);
}

export function rmsToDecibels(rms: number): number {
  if (rms <= 0) return -60;
  return Math.max(-60, Math.min(0, 20 * Math.log10(rms)));
}

export function decibelsToMeter(decibels: number): number {
  return Math.max(0, Math.min(1, (decibels + 60) / 60));
}

/** Kept as a detailed-input type for pack compatibility; the detector emits one click only. */
export type ClickPattern = "CLICK_SINGLE";

export interface ClickDetection {
  input: ClickPattern;
  confidence: number;
}

export interface ClickWaveformFeatures {
  rms: number;
  peak: number;
  crestFactor: number;
  zeroCrossingRate: number;
  highFrequencyRatio: number;
}

export interface ClickScoreDebug {
  score: number;
  minimumScore: number;
  levelScore: number;
  transientScore: number;
  textureScore: number;
  rms: number;
  baselineRms: number | null;
  thresholdRms: number | null;
  features: ClickWaveformFeatures | null;
  detected: boolean;
}

export interface ClickDetectorOptions {
  settleMs: number;
  calibrationMs: number;
  minimumRms: number;
  thresholdMultiplier: number;
  maximumThreshold: number;
  releaseRatio: number;
  minimumScore: number;
  cooldownMs: number;
}

const defaultClickDetectorOptions: ClickDetectorOptions = {
  settleMs: 250,
  calibrationMs: 1750,
  minimumRms: 0.012,
  thresholdMultiplier: 4,
  maximumThreshold: 0.12,
  releaseRatio: 0.45,
  minimumScore: 0.68,
  cooldownMs: 260
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/** Extracts inexpensive time-domain features from one analyser window. */
export function analyzeClickWaveform(samples: Float32Array): ClickWaveformFeatures {
  if (samples.length === 0) return { rms: 0, peak: 0, crestFactor: 0, zeroCrossingRate: 0, highFrequencyRatio: 0 };
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;
  let sumSquares = 0;
  let sumDifferenceSquares = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let previous = samples[0] - mean;
  for (const rawSample of samples) {
    const sample = rawSample - mean;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if ((sample < 0 && previous >= 0) || (sample >= 0 && previous < 0)) zeroCrossings += 1;
    const difference = sample - previous;
    sumDifferenceSquares += difference * difference;
    previous = sample;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  const crestFactor = rms > 0 ? peak / rms : 0;
  // A first-difference energy ratio is a cheap proxy for rapidly changing,
  // high-frequency content. It is deliberately exposed for tuning with real samples.
  const highFrequencyRatio = clamp01(Math.sqrt(sumDifferenceSquares / Math.max(sumSquares, 1e-12)) / 2);
  return {
    rms,
    peak,
    crestFactor,
    zeroCrossingRate: samples.length > 1 ? zeroCrossings / (samples.length - 1) : 0,
    highFrequencyRatio
  };
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))];
}

/** Converts short RMS peaks into click reactions without retaining audio samples. */
export class ClickPatternDetector {
  private readonly options: ClickDetectorOptions;
  private readonly calibrationValues: number[] = [];
  private threshold: number | null = null;
  private peakArmed = true;
  private lastDetectionAt: number | null = null;
  private lastDebug: ClickScoreDebug = {
    score: 0,
    minimumScore: defaultClickDetectorOptions.minimumScore,
    levelScore: 0,
    transientScore: 0,
    textureScore: 0,
    rms: 0,
    baselineRms: null,
    thresholdRms: null,
    features: null,
    detected: false
  };

  constructor(options: Partial<ClickDetectorOptions> = {}) {
    this.options = { ...defaultClickDetectorOptions, ...options };
  }

  get isCalibrating(): boolean { return this.threshold === null; }

  get thresholdRms(): number | null { return this.threshold; }

  get scoreDebug(): ClickScoreDebug { return this.lastDebug; }

  observe(rms: number, elapsedMs: number, features: ClickWaveformFeatures | null = null): ClickDetection | null {
    this.lastDebug = {
      score: 0,
      minimumScore: this.options.minimumScore,
      levelScore: 0,
      transientScore: 0,
      textureScore: 0,
      rms,
      baselineRms: this.threshold === null ? null : this.lastDebug.baselineRms,
      thresholdRms: this.threshold,
      features,
      detected: false
    };
    if (this.threshold === null) {
      if (elapsedMs >= this.options.settleMs && elapsedMs < this.options.settleMs + this.options.calibrationMs) {
        this.calibrationValues.push(rms);
        return null;
      }
      if (elapsedMs < this.options.settleMs + this.options.calibrationMs) return null;
      const baseline = percentile95(this.calibrationValues);
      this.threshold = Math.min(this.options.maximumThreshold, Math.max(this.options.minimumRms, baseline * this.options.thresholdMultiplier));
      this.lastDebug.baselineRms = baseline;
      this.lastDebug.thresholdRms = this.threshold;
    }

    const baseline = this.lastDebug.baselineRms ?? 0;
    const levelScore = clamp01((rms - baseline * 1.25) / Math.max((this.threshold ?? this.options.minimumRms) - baseline * 1.25, 1e-6));
    const transientScore = features ? clamp01((features.crestFactor - 2.2) / 6) : levelScore;
    const textureScore = features ? clamp01((features.highFrequencyRatio - 0.08) / 0.55) : levelScore;
    const score = features
      ? levelScore * 0.7 + transientScore * 0.2 + textureScore * 0.1
      : levelScore;
    this.lastDebug = {
      ...this.lastDebug,
      score,
      levelScore,
      transientScore,
      textureScore,
      baselineRms: baseline,
      thresholdRms: this.threshold,
      detected: false
    };

    if (rms < this.threshold * this.options.releaseRatio) this.peakArmed = true;
    if (this.lastDetectionAt !== null && elapsedMs - this.lastDetectionAt < this.options.cooldownMs) return null;
    if (!this.peakArmed || rms < this.threshold || score < this.options.minimumScore) return null;
    this.peakArmed = false;
    this.lastDetectionAt = elapsedMs;
    this.lastDebug = { ...this.lastDebug, detected: true };
    return {
      input: "CLICK_SINGLE",
      confidence: Math.max(0.7, Math.min(0.98, 0.58 + score * 0.4))
    }
  }
}

export function microphoneErrorKind(error: unknown): "denied" | "missing" | "busy" | "error" {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "missing";
  if (name === "NotReadableError" || name === "TrackStartError") return "busy";
  return "error";
}

type MicrophoneRelease = () => void | Promise<void>;
const microphoneReleases = new Set<MicrophoneRelease>();
let lastMicrophoneReleaseAt = 0;

export function registerMicrophoneRelease(release: MicrophoneRelease): () => void {
  microphoneReleases.add(release);
  return () => microphoneReleases.delete(release);
}

export function noteMicrophoneReleased(): void {
  lastMicrophoneReleaseAt = Date.now();
}

export async function releaseMicrophoneForPlayback(): Promise<void> {
  if (microphoneReleases.size > 0) {
    await Promise.allSettled([...microphoneReleases].map((release) => release()));
  }
  // Windows/WebView2 and Bluetooth headsets may need a moment to restore the
  // normal playback endpoint after an input stream is closed.
  const remaining = 180 - (Date.now() - lastMicrophoneReleaseAt);
  if (remaining > 0) await new Promise<void>((resolve) => globalThis.setTimeout(resolve, remaining));
}
