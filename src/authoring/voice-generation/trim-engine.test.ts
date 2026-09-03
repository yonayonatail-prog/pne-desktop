import { describe, expect, it } from "vitest";
import { detectSpeechSegments, trimAudio } from "./trim-engine";
import type { TrimPlan } from "../types";

function threeSpeechSegments(): Float32Array {
  const samples = new Float32Array(1_000);
  for (const [start, end] of [[0, 200], [400, 600], [800, 1_000]]) {
    for (let index = start; index < end; index += 1) samples[index] = 0.2;
  }
  return samples;
}

function fourSpeechSegments(): Float32Array {
  const samples = new Float32Array(1_400);
  for (const [start, end] of [[0, 200], [400, 600], [800, 1_000], [1_200, 1_400]]) {
    for (let index = start; index < end; index += 1) samples[index] = 0.2;
  }
  return samples;
}

const plan: TrimPlan = {
  enabled: true,
  prefix_chars: 10,
  spoken_chars: 10,
  suffix_chars: 10,
  total_chars: 30,
  predicted_start_ratio: 1 / 3,
  predicted_end_ratio: 2 / 3
};

describe("dialogue trim engine", () => {
  it("selects the middle speech segment when context produces three segments", () => {
    const samples = threeSpeechSegments();
    expect(detectSpeechSegments(samples, 1_000)).toHaveLength(3);
    const result = trimAudio(samples, 1_000, plan);
    expect(result.status).toBe("ok");
    expect(result.startMs).toBe(370);
    expect(result.endMs).toBe(650);
    expect(result.samples.length).toBe(280);
  });

  it("selects the speech segment aligned with the spoken-text ratio instead of always taking the second one", () => {
    const samples = fourSpeechSegments();
    const result = trimAudio(samples, 1_000, {
      ...plan,
      prefix_chars: 20,
      predicted_start_ratio: 0.5,
      predicted_end_ratio: 0.75
    });
    expect(result.status).toBe("ok");
    expect(result.startMs).toBe(770);
    expect(result.endMs).toBe(1_050);
  });

  it("falls back to the predicted ratio when no speech boundary is found", () => {
    const result = trimAudio(new Float32Array(1_000), 1_000, plan);
    expect(result.status).toBe("silence_not_found");
    expect(result.warnings[0]).toContain("発話境界を検出できず");
  });

  it("keeps all speech segments inside the target instead of selecting only one", () => {
    const samples = new Float32Array(2_000);
    for (const [start, end] of [[0, 200], [500, 700], [800, 1_000], [1_200, 1_400]]) {
      for (let index = start; index < end; index += 1) samples[index] = 0.2;
    }

    const result = trimAudio(samples, 1_000, {
      enabled: true,
      prefix_chars: 20,
      spoken_chars: 30,
      suffix_chars: 30,
      total_chars: 80,
      predicted_start_ratio: 0.25,
      predicted_end_ratio: 0.625
    });

    expect(result.status).toBe("ok");
    expect(result.startMs).toBe(470);
    expect(result.endMs).toBe(1_050);
    expect(result.samples.length).toBe(580);
  });

  it("uses the final speech boundary when the target has no suffix context", () => {
    const samples = new Float32Array(1_400);
    for (const [start, end] of [[0, 200], [500, 700], [800, 1_000]]) {
      for (let index = start; index < end; index += 1) samples[index] = 0.2;
    }

    const result = trimAudio(samples, 1_000, {
      ...plan,
      prefix_chars: 20,
      spoken_chars: 60,
      suffix_chars: 0,
      total_chars: 80,
      predicted_start_ratio: 0.25,
      predicted_end_ratio: 1
    });

    expect(result.status).toBe("ok");
    expect(result.startMs).toBe(470);
    expect(result.endMs).toBe(1_050);
  });
});
