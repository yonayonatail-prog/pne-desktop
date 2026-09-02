import { validateScenario, type NameSlot, type Scenario } from "../../player-core/src";

export const SUPPORTED_FEATURES = new Set(["reaction.v1", "history.v1", "name_voice.v1"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ACCEPTED_MIME = new Set(["audio/wav", "audio/mpeg", "image/png", "image/jpeg", "image/webp"]);

export interface PneAsset {
  asset_id: string; path: string; kind: "voice" | "bgm" | "se" | "voice_reference" | "image";
  mime: string; bytes: number; sha256: string; duration_ms?: number;
}
export interface AssetsFile { schema_version: "1.0"; assets: PneAsset[] }

export interface PneVoiceProfile {
  voice_id: string;
  model_id?: string;
  model_version?: string;
  references?: Record<string, string>;
  authorization_id?: string;
}

export interface PneManifest {
  format: "pne"; format_version: string; work_id: string; release_id: string; work_version: string;
  content_graph_hash: string; title: string; entry_node: string; timeline_duration_ms: number;
  runtime_state_schema: { version: string; variables: Record<string, unknown> };
  scenario_path: "scenario.json"; assets_path: "assets.json"; required_features: string[];
  capabilities: { web_playable: boolean; desktop_playable: boolean; name_call_supported: boolean; mobile_transfer_supported: boolean };
  name_voice?: { preview_slot_id?: string; required_models: Array<{ model_id: string; model_version: string }>; voice_profiles: PneVoiceProfile[]; slots: NameSlot[] };
}

export class PneValidationError extends Error {
  constructor(public readonly problems: string[]) { super(problems.join("\n")); this.name = "PneValidationError"; }
}

export function validatePackageContract(manifest: PneManifest, assetsFile: AssetsFile, scenario: Scenario): void {
  const problems: string[] = [];
  if (manifest.format !== "pne") problems.push("manifest.format must be pne");
  if (!SEMVER.test(manifest.format_version) || !manifest.format_version.startsWith("1.")) problems.push("unsupported format_version");
  if (!SEMVER.test(manifest.work_version)) problems.push("invalid work_version");
  for (const [name, value] of [["work_id", manifest.work_id], ["release_id", manifest.release_id]] as const) if (!ID.test(value)) problems.push(`invalid ${name}`);
  if (!SHA256.test(manifest.content_graph_hash)) problems.push("invalid content_graph_hash");
  if (manifest.scenario_path !== "scenario.json" || manifest.assets_path !== "assets.json") problems.push("v1 metadata paths must be canonical");
  for (const feature of manifest.required_features) if (!SUPPORTED_FEATURES.has(feature)) problems.push(`unknown required feature: ${feature}`);
  if (manifest.entry_node !== scenario.entry_node) problems.push("manifest and scenario entry_node differ");
  const slots = manifest.name_voice?.slots ?? [];
  const voiceProfiles = manifest.name_voice?.voice_profiles ?? [];
  const voiceIds = new Set<string>();
  for (const profile of voiceProfiles) {
    if (!ID.test(profile.voice_id) || voiceIds.has(profile.voice_id)) problems.push(`invalid or duplicate voice profile: ${profile.voice_id}`);
    voiceIds.add(profile.voice_id);
  }
  const slotIds = new Set<string>();
  for (const slot of slots) {
    if (!ID.test(slot.slot_id) || slotIds.has(slot.slot_id)) problems.push(`invalid or duplicate slot: ${slot.slot_id}`);
    slotIds.add(slot.slot_id);
    if (!ID.test(slot.fallback_clip_id) || !slot.fallback_text) problems.push(`${slot.slot_id}: fallback is required`);
    if (slot.voice_id && !voiceIds.has(slot.voice_id)) problems.push(`${slot.slot_id}: voice profile does not resolve`);
    if (slot.form && !["bare", "san", "kun", "chan", "senpai", "profile"].includes(slot.form)) problems.push(`${slot.slot_id}: invalid name form`);
  }
  if (manifest.name_voice?.preview_slot_id && !slotIds.has(manifest.name_voice.preview_slot_id)) problems.push("preview_slot_id does not resolve");
  const assetIds = new Set<string>(); const paths = new Set<string>(); let declaredBytes = 0;
  if (assetsFile.schema_version !== "1.0") problems.push("assets schema_version must be 1.0");
  if (assetsFile.assets.length > 20_000) problems.push("asset count exceeds 20,000");
  for (const asset of assetsFile.assets) {
    const normalized = asset.path.replaceAll("\\", "/"); const folded = normalized.toLocaleLowerCase("en-US");
    if (!ID.test(asset.asset_id) || assetIds.has(asset.asset_id)) problems.push(`invalid or duplicate asset: ${asset.asset_id}`);
    assetIds.add(asset.asset_id);
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) problems.push(`${asset.asset_id}: unsafe path`);
    if (paths.has(folded)) problems.push(`${asset.asset_id}: duplicate case-folded path`);
    paths.add(folded);
    if (!ACCEPTED_MIME.has(asset.mime)) problems.push(`${asset.asset_id}: unsupported mime`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > 512 * 1024 * 1024) problems.push(`${asset.asset_id}: invalid size`);
    if (!SHA256.test(asset.sha256)) problems.push(`${asset.asset_id}: invalid SHA-256`);
    declaredBytes += asset.bytes;
  }
  if (declaredBytes > 2 * 1024 * 1024 * 1024) problems.push("declared asset total exceeds 2 GiB");
  try { validateScenario(scenario, slots); } catch (error) { problems.push(...(error as { problems?: string[] }).problems ?? [String(error)]); }
  for (const slot of slots) if (!assetIds.has(slot.fallback_clip_id)) problems.push(`${slot.slot_id}: fallback asset does not resolve`);
  if (problems.length) throw new PneValidationError(problems);
}

export function contentGraphProjection(manifest: PneManifest, scenario: Scenario) {
  return {
    graph_schema_version: "1.0",
    runtime_state_schema: manifest.runtime_state_schema,
    name_slots: [...(manifest.name_voice?.slots ?? [])].sort((a, b) => a.slot_id.localeCompare(b.slot_id)).map(({ slot_id, fallback_clip_id, fallback_text, pre_gap_ms = 0, post_gap_ms = 0, crossfade_ms = 0 }) => ({ slot_id, fallback_clip_id, fallback_text, pre_gap_ms, post_gap_ms, crossfade_ms })),
    scenario: { ...scenario, nodes: [...scenario.nodes].sort((a, b) => a.id.localeCompare(b.id)) }
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  throw new TypeError("unsupported canonical JSON value");
}

export async function calculateContentGraphHash(manifest: PneManifest, scenario: Scenario): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(contentGraphProjection(manifest, scenario)));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
}
