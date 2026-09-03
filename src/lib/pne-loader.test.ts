import { describe, expect, it } from "vitest";
import { buildPnePackage, type ProjectFile } from "../../packages/pne-pack/src";
import { loadPnePackageBytes } from "./pne-loader";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("pne-loader", () => {
  it("exposes verified voice, SE, and image assets through runtime URLs", async () => {
    const result = await buildPnePackage({
      statekitPack: {
        format: "pne_statekit_pack",
        schema_version: "1.0.0",
        meta: { title: "ローダー確認", version: "1.0.0" },
        entry_node: "START",
        state_schema: { variables: [], flags: [] },
        nodes: [{
          id: "START", type: "normal", text: "再生確認", next: "END",
          audio: { voice: "voice_line", se: ["se_door"] },
          display_sequence: [{ text: "再生確認" }, { image_asset_id: "image_room" }]
        }, { id: "END", type: "end", text: "完了" }]
      },
      files: [
        { path: "assets/voice/voice_line.wav", bytes: bytes("voice") },
        { path: "assets/se/se_door.wav", bytes: bytes("se") },
        { path: "assets/image/image_room.webp", bytes: bytes("image") }
      ] satisfies ProjectFile[]
    });

    const work = await loadPnePackageBytes(result.archive, "loaded.pne");

    expect(work.workId).toBe(result.manifest.work_id);
    expect(work.assetUrls?.voice_line).toMatch(/^blob:/);
    expect(work.assetUrls?.se_door).toMatch(/^blob:/);
    expect(work.assetUrls?.image_room).toMatch(/^blob:/);
    expect(work.scenario.nodes[0].audio?.sequence).toEqual([
      { clip_id: "voice_line" },
      { clip_id: "se_door" }
    ]);
  });
});
