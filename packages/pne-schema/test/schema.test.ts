import { describe, expect, it } from "vitest";
import { calculateContentGraphHash, canonicalJson, PneValidationError, validatePackageContract, type AssetsFile, type PneManifest } from "../src";
import type { Scenario } from "../../player-core/src";

const scenario: Scenario = { schema_version: "1.0", entry_node: "END", nodes: [{ id: "END", type: "end", timeline_ms: 0, display_sequence: [{ text: "end" }] }] };
const manifest: PneManifest = {
  format: "pne", format_version: "1.0.0", work_id: "fixture", release_id: "rel_fixture_1", work_version: "1.0.0",
  content_graph_hash: "0".repeat(64), title: "fixture", entry_node: "END", timeline_duration_ms: 0,
  runtime_state_schema: { version: "1.0", variables: {} }, scenario_path: "scenario.json", assets_path: "assets.json",
  required_features: [], capabilities: { web_playable: true, desktop_playable: true, name_call_supported: false, mobile_transfer_supported: false }
};
const assets: AssetsFile = { schema_version: "1.0", assets: [] };

describe("pne package contract", () => {
  it("accepts the canonical empty fixture", () => expect(() => validatePackageContract(manifest, assets, scenario)).not.toThrow());
  it("accepts multiple voice profiles bound to separate name slots", () => {
    const multiVoiceManifest: PneManifest = {
      ...manifest,
      capabilities: { ...manifest.capabilities, name_call_supported: true },
      name_voice: {
        required_models: [{ model_id: "irodori", model_version: "1.0.0" }],
        voice_profiles: [{ voice_id: "char_aya" }, { voice_id: "char_ren" }],
        slots: [
          { slot_id: "name.aya", voice_id: "char_aya", form: "san", fallback_clip_id: "fallback.aya", fallback_text: "あなた" },
          { slot_id: "name.ren", voice_id: "char_ren", form: "profile", fallback_clip_id: "fallback.ren", fallback_text: "あなた" }
        ]
      }
    };
    const multiAssets: AssetsFile = { schema_version: "1.0", assets: [
      { asset_id: "fallback.aya", path: "audio/fallback_aya.wav", kind: "voice", mime: "audio/wav", bytes: 1, sha256: "a".repeat(64) },
      { asset_id: "fallback.ren", path: "audio/fallback_ren.wav", kind: "voice", mime: "audio/wav", bytes: 1, sha256: "b".repeat(64) }
    ] };
    expect(() => validatePackageContract(multiVoiceManifest, multiAssets, scenario)).not.toThrow();
  });
  it("rejects traversal and case-colliding assets", () => {
    const broken: AssetsFile = { schema_version: "1.0", assets: [
      { asset_id: "a", path: "audio/../bad.wav", kind: "voice", mime: "audio/wav", bytes: 1, sha256: "a".repeat(64) },
      { asset_id: "b", path: "AUDIO/../BAD.wav", kind: "voice", mime: "audio/wav", bytes: 1, sha256: "b".repeat(64) }
    ] };
    expect(() => validatePackageContract(manifest, broken, scenario)).toThrow(PneValidationError);
  });
  it("canonicalizes object keys and returns a stable SHA-256", async () => {
    expect(canonicalJson({ z: 1, a: [true, "x"] })).toBe('{"a":[true,"x"],"z":1}');
    const first = await calculateContentGraphHash(manifest, scenario);
    const second = await calculateContentGraphHash(structuredClone(manifest), structuredClone(scenario));
    expect(first).toMatch(/^[a-f0-9]{64}$/); expect(second).toBe(first);
  });
});
