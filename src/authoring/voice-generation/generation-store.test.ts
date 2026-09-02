import { describe, expect, it } from "vitest";
import { emptyVoiceGenerationManifest, selectVoiceCandidate } from "./generation-store";
import type { GenerationRoundRecord } from "../types";

function round(id: string, status: GenerationRoundRecord["status"]): GenerationRoundRecord {
  const candidate = (variant: "A" | "B" | "C") => ({ candidate_id: `${id}_${variant}`, variant, status: "trimmed" as const, seed: 1, num_steps: 34 as const, seconds: 10, warnings: [] });
  return {
    round_id: id,
    generation_unit_id: "unit_N1",
    speaker_id: "A",
    voice_preset_id: "preset_test",
    voice_mode: "reference",
    spoken_text: "台詞",
    candidates: [candidate("A"), candidate("B"), candidate("C")],
    seed_base: 1,
    num_steps: 34,
    seconds: 10,
    pace_multiplier: 1,
    status,
    created_at: new Date().toISOString()
  };
}

describe("voice generation manifest", () => {
  it("marks the selected round and candidate while superseding the previous round", () => {
    const manifest = emptyVoiceGenerationManifest("project-test");
    manifest.units.push({ generation_unit_id: "unit_N1", source_line_ids: ["N1"], rounds: [round("r1", "selected"), round("r2", "ready")] });
    const next = selectVoiceCandidate(manifest, "unit_N1", "r2", "r2_B");
    const unit = next.units[0];
    expect(unit.selected_round_id).toBe("r2");
    expect(unit.selected_candidate_id).toBe("r2_B");
    expect(unit.rounds.map((entry) => entry.status)).toEqual(["superseded", "selected"]);
  });
});
