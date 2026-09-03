import { describe, expect, it } from "vitest";
import { DialogueVoiceGenerator } from "./generation-manager";
import type { AuthoringNode, VoicePreset } from "../types";

const preset: VoicePreset = {
  voice_preset_id: "preset_test",
  label: "テスト声",
  group: "テスト",
  tags: [],
  mode: "reference",
  model_id: "irodori-test"
};

const nodes: AuthoringNode[] = [
  { id: "N1", type: "normal", speaker: "A", text: "前文", next: "N2" },
  { id: "N2", type: "normal", speaker: "A", text: "生成対象の台詞です。", next: "N3" },
  { id: "N3", type: "normal", speaker: "A", text: "後文", next: null }
];

function fakeAudio(): Float32Array {
  const audio = new Float32Array(1_000);
  for (const [start, end] of [[0, 200], [400, 600], [800, 1_000]]) {
    for (let index = start; index < end; index += 1) audio[index] = 0.2;
  }
  return audio;
}

describe("dialogue generation manager", () => {
  it("generates A/B/C with fixed num_steps and one shared seconds value", async () => {
    const calls: Array<{ text: string; numSteps: number; seed: number; seconds: number }> = [];
    const generator = new DialogueVoiceGenerator({
      synthesizeContext: async (text, _referenceUrl, options) => {
        calls.push({ text, numSteps: options.numSteps, seed: options.seed, seconds: options.seconds });
        return { audio: fakeAudio(), sampleRate: 1_000, referenceFingerprint: "ref-test" };
      }
    });

    const round = await generator.generateRound({ nodes, nodeId: "N2", preset, referenceUrl: "blob:test", paceMultiplier: 1.16, seedBase: 1234 });

    expect(round.status).toBe("ready");
    expect(round.candidates.map((candidate) => candidate.variant)).toEqual(["A", "B", "C"]);
    expect(round.candidates.every((candidate) => candidate.status === "trimmed")).toBe(true);
    expect(round.candidates.every((candidate) => candidate.num_steps === 34)).toBe(true);
    expect(new Set(round.candidates.map((candidate) => candidate.seconds)).size).toBe(1);
    expect(new Set(calls.map((call) => call.numSteps))).toEqual(new Set([34]));
    expect(new Set(calls.map((call) => call.seconds)).size).toBe(1);
    expect(new Set(calls.map((call) => call.seed))).toEqual(new Set([1234]));
    expect(round.reference_fingerprint).toBe("ref-test");
  });

  it.each([
    ["non-finite", new Float32Array([Number.NaN, 0.2])],
    ["silent", new Float32Array(1_000)]
  ])("rejects %s model output instead of storing a ready silent candidate", async (_label, audio) => {
    const generator = new DialogueVoiceGenerator({
      synthesizeContext: async () => ({ audio, sampleRate: 1_000 })
    });

    const round = await generator.generateRound({ nodes, nodeId: "N2", preset, referenceUrl: "blob:test", seedBase: 1234 });

    expect(round.status).toBe("failed");
    expect(round.candidates.every((candidate) => candidate.status === "failed")).toBe(true);
    expect(round.candidates.every((candidate) => candidate.error_code === "INVALID_GENERATED_AUDIO")).toBe(true);
  });
});
