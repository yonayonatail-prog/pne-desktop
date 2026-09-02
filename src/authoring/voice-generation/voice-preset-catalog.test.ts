import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_PRESETS } from "./voice-preset-catalog";

describe("bundled voice preset catalog", () => {
  it("contains selectable female and male reference samples", () => {
    expect(new Set(DEFAULT_VOICE_PRESETS.map((preset) => preset.group))).toEqual(new Set(["女性", "男性"]));
    for (const preset of DEFAULT_VOICE_PRESETS) {
      expect(preset.mode).toBe("reference");
      expect(preset.reference_audio).toBeTruthy();
      expect(existsSync(join(process.cwd(), "img", preset.reference_audio!.slice(1)))).toBe(true);
    }
  });
});
