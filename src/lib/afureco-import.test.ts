import { describe, expect, it } from "vitest";
import { normalizeAfurecoProject, parseAfurecoProjectJson } from "./afureco-import";

describe("afureco JSON import", () => {
  it("converts a statekit nodes pack and resolves character names", () => {
    const project = normalizeAfurecoProject({
      meta: { title: "雨の部屋", version: "1.2.0" },
      character_definition: { hiiro: { name: "ヒイロ" } },
      nodes: [
        { id: "START", type: "start", speaker: "hiiro", text: "聞こえる？", performance: { tone: "quiet", pace: "slow" } },
        { id: "END", type: "end", speaker: "NARRATOR", text: "雨音が遠ざかる。" }
      ]
    }, "rain.json");

    expect(project.projectName).toBe("雨の部屋・アフレコ案件");
    expect(project.scriptVersion).toBe("1.2.0");
    expect(project.assignedCharacter).toBe("ヒイロ");
    expect(project.lines).toHaveLength(2);
    expect(project.lines[0]).toMatchObject({ nodeId: "START", speakerName: "ヒイロ", text: "聞こえる？", direction: "tone: quiet / pace: slow" });
  });

  it("supports scenario display sequences and keeps name slots in the recording text", () => {
    const project = parseAfurecoProjectJson(JSON.stringify({
      workId: "scenario-work",
      title: "シナリオ", 
      scenario: { nodes: [{ id: "N1", speaker: "？？？", display_sequence: [{ text: "……" }, { name_slot_id: "name" }, { text: "。" }] }] }
    }), "scenario.json");

    expect(project.lines[0]).toMatchObject({ nodeId: "N1", text: "……{{name}}。", speakerName: "？？？" });
  });

  it("flattens canonical script-pack lines and narration for afureco", () => {
    const project = normalizeAfurecoProject({
      format: "pne_script_pack",
      schema_version: "1.0.0",
      meta: { title: "雨が止むまで", version: "0.1" },
      character_definition: { char_hiyori: { name: "ひより" } },
      nodes: [{
        node_id: "INTRO",
        state: "introduction",
        lines: [{ line_id: "INTRO_001", speaker: "char_hiyori", text: "先輩、雨ですね。", performance: { preset: "quiet" } }],
        narration: [{ narration_id: "INTRO_N001", text: "放課後の雨。", performance: { preset: "narration" } }]
      }]
    }, "rain.json");

    expect(project.lines).toHaveLength(2);
    expect(project.lines[0]).toMatchObject({ nodeId: "INTRO", text: "先輩、雨ですね。", speakerName: "ひより" });
    expect(project.lines[1]).toMatchObject({ nodeId: "INTRO", lineId: expect.stringContaining("INTRO-N001"), text: "放課後の雨。", speakerName: "NARRATOR" });
  });

  it("supports audio pipeline batches split into source segments", () => {
    const project = normalizeAfurecoProject({
      meta: { title: "収録済み台本" },
      batches: [{ speaker: "男", state: "N1", source_segments: [{ id: "N1_01", text: "最初の台詞" }, { id: "N1_02", text: "次の台詞" }] }]
    }, "manifest.json");

    expect(project.lines.map((line) => line.text)).toEqual(["最初の台詞", "次の台詞"]);
    expect(project.lines.every((line) => line.speakerName === "男")).toBe(true);
  });

  it("rejects JSON without spoken lines and reports malformed JSON", () => {
    expect(() => normalizeAfurecoProject({ meta: { title: "empty" } }, "empty.json")).toThrow("アフレコ用のセリフが見つかりません");
    expect(() => parseAfurecoProjectJson("{", "broken.json")).toThrow("broken.json: JSON構文エラー");
  });
});
