import { describe, expect, it } from "vitest";
import { estimateSeconds, FIXED_NUM_STEPS, MAX_SECONDS, MIN_SECONDS } from "./duration-policy";

describe("dialogue duration policy", () => {
  it("keeps num_steps fixed and derives a slower pace from seconds", () => {
    expect(FIXED_NUM_STEPS).toBe(34);
    const standard = estimateSeconds("これは生成時間を測るための台詞です。", 1);
    const slow = estimateSeconds("これは生成時間を測るための台詞です。", 1.16);
    expect(slow).toBeGreaterThanOrEqual(standard);
  });

  it("clamps very short and long lines to safe duration bounds", () => {
    expect(estimateSeconds("短い", 1)).toBe(MIN_SECONDS);
    expect(estimateSeconds("あ".repeat(500), 1.2)).toBe(MAX_SECONDS);
  });
});
