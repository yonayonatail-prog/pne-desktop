import { describe, expect, it } from "vitest";
import { buildContextVariants } from "./context-builder";
import type { AuthoringNode } from "../types";

const nodes: AuthoringNode[] = [
  { id: "N1", type: "normal", speaker: "ヒイロ", text: "前の台詞です。", next: "N2" },
  { id: "N2", type: "normal", speaker: "ヒイロ", text: "ここが生成したい台詞です。", performance: { tone: "少し不安", pace: "ゆっくり" }, next: "N3" },
  { id: "N3", type: "normal", speaker: "ヒイロ", text: "次の台詞です。", next: null }
];

describe("context builder", () => {
  it("builds three context takes around the same spoken text", () => {
    const unit = buildContextVariants(nodes, "N2");
    expect(unit.source_line_ids).toEqual(["N2"]);
    expect(unit.spoken_text).toBe("ここが生成したい台詞です。");
    expect(unit.takes.map((take) => take.variant)).toEqual(["A", "B", "C"]);
    expect(unit.takes.every((take) => take.spoken_text === unit.spoken_text)).toBe(true);
    expect(unit.takes[0].generation_text).toContain("前の台詞です。");
    expect(unit.takes[1].generation_text).toContain("感情は少し不安。");
    expect(unit.takes[1].generation_text).toContain("次の台詞です。");
    expect(unit.takes[2].trim_plan.predicted_end_ratio).toBeGreaterThan(unit.takes[2].trim_plan.predicted_start_ratio);
  });

  it("ports the first-person context as a prefix before the spoken line", () => {
    const unit = buildContextVariants(nodes, "N2", { firstPerson: "私" });

    expect(unit.takes[0].prefix_context).toContain("私は相手に向かって話している。");
    expect(unit.takes[1].prefix_context).toContain("私は感情は少し不安、読みのテンポはゆっくりで相手に話す。");
    expect(unit.takes[2].prefix_context).toContain("この場面。私は目の前の相手へ自然に言葉を続ける。");
    expect(unit.takes.every((take) => take.generation_text.indexOf(take.spoken_text) > take.generation_text.indexOf(take.prefix_context))).toBe(true);
  });
});
