import { afterEach, describe, expect, it, vi } from "vitest";
import { ClickPatternDetector, analyzeClickWaveform, decibelsToMeter, noteMicrophoneReleased, registerMicrophoneRelease, releaseMicrophoneForPlayback, rmsFromTimeDomain, rmsToDecibels } from "./microphone";

afterEach(() => vi.useRealTimers());

describe("microphone level helpers", () => {
  it("calculates RMS from time-domain samples", () => {
    expect(rmsFromTimeDomain(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rmsFromTimeDomain(new Float32Array())).toBe(0);
  });

  it("clamps decibels to the displayed meter range", () => {
    expect(rmsToDecibels(0)).toBe(-60);
    expect(rmsToDecibels(1)).toBe(0);
    expect(decibelsToMeter(-60)).toBe(0);
    expect(decibelsToMeter(-30)).toBe(0.5);
    expect(decibelsToMeter(0)).toBe(1);
  });

  it("releases an active tester before audible playback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00Z"));
    const release = vi.fn(() => noteMicrophoneReleased());
    const unregister = registerMicrophoneRelease(release);

    const ready = releaseMicrophoneForPlayback();
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180);
    await ready;
    unregister();
  });

  it("extracts waveform features for score debugging", () => {
    const features = analyzeClickWaveform(new Float32Array([0, 0.2, -0.2, 0.1, 0]));
    expect(features.peak).toBeCloseTo(0.22);
    expect(features.rms).toBeGreaterThan(0);
    expect(features.crestFactor).toBeGreaterThan(1);
    expect(features.zeroCrossingRate).toBeGreaterThan(0);
    expect(features.highFrequencyRatio).toBeGreaterThan(0);
  });

  it("emits one click immediately after the score crosses the threshold", () => {
    const detector = new ClickPatternDetector({ settleMs: 0, calibrationMs: 100, minimumRms: 0.01 });
    detector.observe(0.001, 0);
    detector.observe(0.001, 100);
    expect(detector.isCalibrating).toBe(false);
    expect(detector.observe(0.04, 120)?.input).toBe("CLICK_SINGLE");
    expect(detector.scoreDebug.score).toBeGreaterThanOrEqual(detector.scoreDebug.minimumScore);
    detector.observe(0, 160);
    expect(detector.observe(0.04, 200)).toBeNull();
  });

  it("does not emit a second click during the cooldown", () => {
    const detector = new ClickPatternDetector({ settleMs: 0, calibrationMs: 100, minimumRms: 0.01, cooldownMs: 250 });
    detector.observe(0.001, 0);
    detector.observe(0.001, 100);
    expect(detector.observe(0.04, 120)?.input).toBe("CLICK_SINGLE");
    detector.observe(0, 170);
    expect(detector.observe(0.04, 250)).toBeNull();
    expect(detector.observe(0, 300)).toBeNull();
    expect(detector.observe(0.04, 400)?.input).toBe("CLICK_SINGLE");
  });
});
