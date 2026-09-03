import { describe, expect, it } from "vitest";
import { buildEditablePnepack, buildPnePackage, inspectPneArchive, readStoredZip, scanProject, writeStoredZip, type ProjectFile } from "../src";

const bytes = (value: string) => new TextEncoder().encode(value);

const basePack = {
  format: "pne_statekit_pack",
  schema_version: "1.0.0",
  meta: { title: "雨の部屋", version: "1.0.0" },
  entry_node: "START",
  state_schema: { variables: [], flags: [] },
  nodes: [
    {
      id: "START",
      type: "normal",
      speaker: "ヒイロ",
      text: "雨の音が聞こえる。",
      audio: { voice: "voice_line_001", se: ["se_rain"] },
      display_sequence: [{ text: "雨の音が聞こえる。" }, { image_asset_id: "image_room" }],
      next: "END"
    },
    { id: "END", type: "end", text: "おしまい。" }
  ]
};

const completeFiles: ProjectFile[] = [
  { path: "assets/voice/voice_line_001.wav", bytes: bytes("voice") },
  { path: "assets/se/se_rain.wav", bytes: bytes("rain") },
  { path: "assets/image/image_room.webp", bytes: bytes("image") }
];

describe("pne-pack", () => {
  it("derives editable asset slots without requiring asset_manifest JSON", async () => {
    const result = await scanProject({
      files: [{ path: "assets/voice/voice_line_001.wav", bytes: bytes("voice") }],
      statekitPack: basePack
    });
    expect(result.assetManifest.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot_id: "voice_line_001", kind: "voice", status: "present" }),
      expect.objectContaining({ slot_id: "se_rain", kind: "se", status: "missing" }),
      expect.objectContaining({ slot_id: "image_room", kind: "image", status: "missing" })
    ]));
    expect(result.issues.some((item) => item.code === "E-ASSET-001" && item.slot_id === "se_rain")).toBe(true);
  });

  it("reports a kind mismatch instead of treating an image as voice audio", async () => {
    const result = await scanProject({ files: [{ path: "assets/voice/voice_line_001.png", bytes: bytes("image") }], statekitPack: basePack });
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "E-ASSET-006", path: "assets/voice/voice_line_001.png" })]));
    expect(result.assetsFile.assets).toHaveLength(0);
  });

  it("allows holes in editable pnepack but blocks runtime pne output", async () => {
    const input = { files: completeFiles.slice(0, 2), statekitPack: basePack, license: {
      license_id: "CC-BY-4.0",
      allow_audio_addition: true,
      allow_external_distribution: true,
      allow_external_sale: true,
      credit_required: true,
      attribution: "P.N.E. sample"
    } };
    const editable = await buildEditablePnepack(input);
    expect(editable.archive.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(editable.assetManifest.slots.find((slot) => slot.slot_id === "image_room")?.status).toBe("missing");
    await expect(buildPnePackage(input)).rejects.toMatchObject({ name: "PnePackError" });
  });

  it("builds and validates a complete pne archive", async () => {
    const result = await buildPnePackage({
      files: completeFiles,
      statekitPack: basePack,
      license: {
        license_id: "CC-BY-4.0",
        allow_audio_addition: true,
        allow_external_distribution: true,
        allow_external_sale: true,
        credit_required: true,
        attribution: "P.N.E. sample"
      }
    });
    expect(result.manifest.format).toBe("pne");
    expect(result.manifest.content_graph_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.assetsFile.assets.map((asset) => asset.kind)).toEqual(["voice", "se", "image"]);
    expect(result.archive.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    const entries = readStoredZip(result.archive);
    expect(entries.map((entry) => entry.path)).toEqual([
      "manifest.json",
      "scenario.json",
      "assets.json",
      "license.json",
      "audio/voice/voice_line_001.wav",
      "audio/se/se_rain.wav",
      "image/image_room.webp"
    ]);
    expect(new TextDecoder().decode(entries[0].bytes)).toContain('"format": "pne"');
    expect(entries.at(-1)?.bytes).toEqual(bytes("image"));
    const inspected = await inspectPneArchive(result.archive);
    expect(inspected.manifest.content_graph_hash).toBe(result.manifest.content_graph_hash);
  });

  it("rejects a corrupted archive instead of returning untrusted bytes", async () => {
    const result = await buildPnePackage({ files: completeFiles, statekitPack: basePack });
    const corrupted = result.archive.slice();
    corrupted[corrupted.length - 24] ^= 0xff;
    expect(() => readStoredZip(corrupted)).toThrow(/ZIP/);
  });

  it("rejects a valid ZIP whose asset payload does not match its manifest", async () => {
    const result = await buildPnePackage({ files: completeFiles, statekitPack: basePack });
    const entries = readStoredZip(result.archive);
    const asset = entries.find((entry) => entry.path === "audio/se/se_rain.wav");
    expect(asset).toBeDefined();
    asset!.bytes[0] ^= 0xff;
    const rebuilt = writeStoredZip(entries);
    await expect(inspectPneArchive(rebuilt)).rejects.toMatchObject({ name: "PnePackError" });
  });
});
