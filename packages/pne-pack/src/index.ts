import {
  calculateContentGraphHash,
  canonicalJson,
  validatePackageContract,
  type AssetsFile,
  type PneAsset,
  type PneLicense,
  type PneManifest
} from "../../pne-schema/src";
import { validateScenario, type AudioPart, type DisplayPart, type Scenario, type ScenarioNode } from "../../player-core/src";

export type ProjectFile = { path: string; bytes: Uint8Array };
export type AssetKind = PneAsset["kind"];

export interface AssetSlot {
  slot_id: string;
  kind: Exclude<AssetKind, "voice_reference">;
  label: string;
  target_path: string;
  required: boolean;
  status: "missing" | "present";
  asset_id?: string;
  source_node_id?: string;
}

export interface EditableAssetManifest {
  schema_version: "1.0";
  assets: PneAsset[];
  slots: AssetSlot[];
}

export interface PnepackManifest {
  format: "pnepack";
  format_version: "1.0.0";
  package_kind: "editable";
  work_id: string;
  title: string;
  work_version: string;
  source_path: "pne_statekit_pack.json";
  asset_manifest_path: "asset_manifest.json";
  license_path: "license.json";
  license: PneLicense;
}

export interface PneProjectInput {
  files: ProjectFile[];
  statekitPack: unknown;
  workId?: string;
  title?: string;
  workVersion?: string;
  releaseId?: string;
  license?: PneLicense;
}

export interface PnePackIssue {
  code: string;
  level: "error" | "warning";
  message: string;
  path?: string;
  slot_id?: string;
  asset_id?: string;
  node_id?: string;
}

export interface ScannedProject {
  workId: string;
  title: string;
  workVersion: string;
  scenario: Scenario;
  assetsFile: AssetsFile;
  assetManifest: EditableAssetManifest;
  issues: PnePackIssue[];
}

export interface BuiltPnePackage {
  archive: Uint8Array;
  manifest: PneManifest;
  scenario: Scenario;
  assetsFile: AssetsFile;
  issues: PnePackIssue[];
}

export interface BuiltPnepack {
  archive: Uint8Array;
  manifest: PnepackManifest;
  assetManifest: EditableAssetManifest;
  issues: PnePackIssue[];
}

export class PnePackError extends Error {
  constructor(public readonly issues: PnePackIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
    this.name = "PnePackError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_METADATA = new Set([
  "pne_statekit_pack.json",
  "manifest.json",
  "asset_manifest.json",
  "license.json",
  "scenario.json",
  "assets.json"
]);

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`unsafe project path: ${path}`);
  }
  return normalized;
}

function slugId(value: string, fallback: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  if (ID.test(ascii)) return ascii;
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${fallback}_${(hash >>> 0).toString(16)}`;
}

function extension(path: string): string {
  return path.toLocaleLowerCase("en-US").split(".").pop() ?? "";
}

function mimeForPath(path: string): string | null {
  switch (extension(path)) {
    case "wav": return "audio/wav";
    case "mp3": return "audio/mpeg";
    case "ogg": return "audio/ogg";
    case "webm": return "audio/webm";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    default: return null;
  }
}

function sourceKind(path: string): Exclude<AssetKind, "voice_reference"> | null {
  const parts = path.split("/");
  if (parts[0] !== "assets") return null;
  switch (parts[1]) {
    case "voice": return "voice";
    case "bgm": return "bgm";
    case "se": return "se";
    case "image": return "image";
    default: return null;
  }
}

function runtimePath(sourcePath: string, kind: Exclude<AssetKind, "voice_reference">): string {
  const rest = sourcePath.split("/").slice(2).join("/");
  return kind === "image" ? `image/${rest}` : `audio/${kind}/${rest}`;
}

function mimeMatchesKind(mime: string, kind: AssetSlot["kind"]): boolean {
  return kind === "image" ? mime.startsWith("image/") : mime.startsWith("audio/");
}

function defaultSourcePath(kind: AssetSlot["kind"], slotId: string): string {
  const ext = kind === "bgm" ? "mp3" : kind === "image" ? "webp" : "wav";
  return `assets/${kind}/${slotId}.${ext}`;
}

function inferKind(assetId: string): AssetSlot["kind"] {
  if (assetId.startsWith("se_") || assetId.startsWith("sfx_")) return "se";
  if (assetId.startsWith("bgm_") || assetId.startsWith("music_")) return "bgm";
  if (assetId.startsWith("image_") || assetId.startsWith("illustration_") || assetId.startsWith("cover")) return "image";
  return "voice";
}

function rawScenario(source: unknown): Record<string, any> {
  if (!isRecord(source)) return {};
  return isRecord(source.scenario) ? source.scenario : source;
}

function rawNodes(source: unknown): Record<string, any>[] {
  const scenario = rawScenario(source);
  return (Array.isArray(scenario.nodes) ? scenario.nodes : [])
    .filter(isRecord);
}

function displaySequence(raw: Record<string, any>): DisplayPart[] | undefined {
  if (Array.isArray(raw.display_sequence)) {
    const parts: DisplayPart[] = [];
    for (const part of raw.display_sequence.filter(isRecord)) {
      if (typeof part.text === "string") { parts.push({ text: part.text }); continue; }
      if (typeof part.name_slot_id === "string") { parts.push({ name_slot_id: part.name_slot_id }); continue; }
      const imageId = part.image_asset_id ?? part.image_id;
      if (typeof imageId === "string") {
        parts.push(typeof part.alt === "string" ? { image_asset_id: imageId, alt: part.alt } : { image_asset_id: imageId });
      }
    }
    if (parts.length) return parts;
  }
  const text = raw.text ?? raw.dialogue ?? raw.narrative_description;
  return typeof text === "string" && text.length ? [{ text }] : undefined;
}

function audioSequence(raw: Record<string, any>): AudioPart[] {
  const audio = isRecord(raw.audio) ? raw.audio : {};
  const sequence: AudioPart[] = [];
  const rawSequence = Array.isArray(audio.sequence) ? audio.sequence : Array.isArray(raw.audio) ? raw.audio : [];
  for (const part of rawSequence) {
    if (typeof part === "string") sequence.push({ clip_id: part });
    else if (isRecord(part) && typeof part.clip_id === "string") sequence.push({ clip_id: part.clip_id });
    else if (isRecord(part) && typeof part.name_slot_id === "string") sequence.push({ name_slot_id: part.name_slot_id });
    else if (isRecord(part) && typeof part.gap_ms === "number") sequence.push({ gap_ms: part.gap_ms });
  }
  const addClip = (value: unknown) => {
    if (typeof value === "string") sequence.push({ clip_id: value });
    if (isRecord(value) && typeof value.asset_id === "string") sequence.push({ clip_id: value.asset_id });
  };
  if (!rawSequence.length) {
    addClip(audio.voice ?? raw.voice_clip_id ?? raw.voiceClipId);
    addClip(audio.bgm ?? raw.bgm);
    const ses = Array.isArray(audio.se) ? audio.se : audio.se ? [audio.se] : Array.isArray(raw.se) ? raw.se : raw.se ? [raw.se] : [];
    ses.forEach(addClip);
  }
  return sequence;
}

function transitionId(raw: Record<string, any>): string {
  if (typeof raw.next === "string") return raw.next;
  if (typeof raw.next_node_id === "string") return raw.next_node_id;
  if (Array.isArray(raw.next_ids) && typeof raw.next_ids[0] === "string") return raw.next_ids[0];
  return "";
}

function compileReaction(raw: Record<string, any>): Extract<ScenarioNode, { type: "reaction_prompt" }>["reaction_window"] {
  const window = isRecord(raw.reaction_window) ? raw.reaction_window : raw;
  const branches = isRecord(window.branches) ? Object.fromEntries(Object.entries(window.branches).filter(([, value]) => typeof value === "string")) : {};
  const accepted = (Array.isArray(window.accepted_raw_inputs) ? window.accepted_raw_inputs.filter((value): value is any => typeof value === "string") : ["VOICE", "SILENT", "NEXT"]) as any[];
  const timeout = (typeof window.timeout_input === "string" ? window.timeout_input : "UNKNOWN") as any;
  const contextMapping = isRecord(window.context_mapping)
    ? Object.fromEntries(Object.entries(window.context_mapping).filter(([, value]) => typeof value === "string"))
    : Object.fromEntries([...accepted, timeout, "UNKNOWN"].map((value) => [value, value]));
  return {
    window_ms: asNumber(window.window_ms, 3000),
    accepted_raw_inputs: accepted,
    timeout_input: timeout,
    context_mapping: contextMapping,
    branches
  };
}

function compileEffects(raw: Record<string, any>): ScenarioNode["effects"] | undefined {
  if (!Array.isArray(raw.effects)) return undefined;
  return raw.effects.filter(isRecord).flatMap((effect) => {
    if (typeof effect.variable !== "string") return [];
    if (!["set", "increment", "decrement", "toggle"].includes(effect.operation)) return [];
    return [typeof effect.value === "undefined"
      ? { variable: effect.variable, operation: effect.operation }
      : { variable: effect.variable, operation: effect.operation, value: effect.value }];
  }) as ScenarioNode["effects"];
}

export function compileStatekitScenario(source: unknown): Scenario {
  const root = rawScenario(source);
  const nodes = rawNodes(source);
  const compiled: ScenarioNode[] = nodes.map((raw, index): ScenarioNode => {
    const id = asString(raw.id ?? raw.node_id, `NODE_${String(index + 1).padStart(3, "0")}`);
    const type = asString(raw.type, "normal");
    const sequence = audioSequence(raw);
    const base: Record<string, any> = {
      id,
      timeline_ms: asNumber(raw.timeline_ms ?? raw.timelineMs, index * 1000),
      ...(typeof raw.speaker === "string" ? { speaker: raw.speaker } : {}),
      ...(displaySequence(raw) ? { display_sequence: displaySequence(raw) } : {}),
      ...(sequence.length ? { audio: { sequence } } : {}),
      ...(compileEffects(raw)?.length ? { effects: compileEffects(raw) } : {})
    };
    if (type === "end") return { ...base, type: "end" } as ScenarioNode;
    if (type === "reaction" || type === "reaction_prompt") return { ...base, type: "reaction_prompt", reaction_window: compileReaction(raw) } as ScenarioNode;
    if (type === "branch") {
      const variants = Array.isArray(raw.variants) ? raw.variants.filter(isRecord).flatMap((variant) => {
        if (typeof variant.next !== "string") return [];
        const conditions = Array.isArray(variant.conditions) ? variant.conditions.filter(isRecord).filter((condition) => typeof condition.variable === "string" && typeof condition.operator === "string") : [];
        return [{ conditions: conditions as any, next: variant.next }];
      }) : [];
      return { ...base, type: "branch", variants, fallback: asString(raw.fallback ?? transitionId(raw)) } as ScenarioNode;
    }
    return {
      ...base,
      type: "line",
      advance: raw.advance === "user_next" ? "user_next" : "auto",
      next: transitionId(raw)
    } as ScenarioNode;
  });
  const entry = asString(root.entry_node ?? root.start_node_id, compiled[0]?.id ?? "");
  return {
    schema_version: "1.0",
    entry_node: entry,
    nodes: compiled
  };
}

function issue(code: string, level: PnePackIssue["level"], message: string, extra: Partial<PnePackIssue> = {}): PnePackIssue {
  return { code, level, message, ...extra };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function collectReferences(scenario: Scenario): Array<{ id: string; kind: AssetSlot["kind"]; nodeId: string }> {
  const refs: Array<{ id: string; kind: AssetSlot["kind"]; nodeId: string }> = [];
  for (const node of scenario.nodes) {
    for (const part of node.audio?.sequence ?? []) {
      if ("clip_id" in part) refs.push({ id: part.clip_id, kind: inferKind(part.clip_id), nodeId: node.id });
    }
    for (const part of node.display_sequence ?? []) {
      if ("image_asset_id" in part) refs.push({ id: part.image_asset_id, kind: "image", nodeId: node.id });
    }
  }
  return refs;
}

function runtimeStateSchema(source: unknown): { version: string; variables: Record<string, unknown> } {
  const root = rawScenario(source);
  const state = isRecord(root.state_schema) ? root.state_schema : {};
  const variables: Record<string, unknown> = {};
  if (Array.isArray(state.variables)) {
    for (const value of state.variables.filter(isRecord)) {
      if (typeof value.key === "string") variables[value.key] = value;
    }
  }
  if (Array.isArray(state.flags)) {
    for (const value of state.flags.filter(isRecord)) {
      if (typeof value.key === "string") variables[value.key] = value;
    }
  }
  return { version: "1.0", variables };
}

function defaultLicense(): PneLicense {
  return {
    license_id: "UNSPECIFIED",
    allow_audio_addition: false,
    allow_external_distribution: false,
    allow_external_sale: false,
    credit_required: true
  };
}

export async function scanProject(input: PneProjectInput): Promise<ScannedProject> {
  const root = isRecord(input.statekitPack) ? input.statekitPack : {};
  const meta = isRecord(root.meta) ? root.meta : {};
  const title = input.title ?? asString(meta.title, "無題のP.N.E.作品");
  const workId = slugId(input.workId ?? title, "work");
  const workVersion = input.workVersion ?? asString(meta.version, "0.1.0");
  const scenario = compileStatekitScenario(input.statekitPack);
  const issues: PnePackIssue[] = [];
  try {
    validateScenario(scenario);
  } catch (error) {
    const problems = (error as { problems?: string[] }).problems ?? [String(error)];
    problems.forEach((message) => issues.push(issue("E-SCENARIO-001", "error", message)));
  }

  const assets: PneAsset[] = [];
  const sourceById = new Map<string, { path: string; kind: AssetSlot["kind"] }>();
  const projectPaths = new Set<string>();
  for (const file of input.files) {
    let path: string;
    try { path = normalizePath(file.path); }
    catch (error) {
      issues.push(issue("E-PATH-001", "error", String(error), { path: file.path }));
      continue;
    }
    if (projectPaths.has(path.toLocaleLowerCase("en-US"))) {
      issues.push(issue("E-PATH-002", "error", `大文字小文字を無視すると重複するパスです: ${path}`, { path }));
      continue;
    }
    projectPaths.add(path.toLocaleLowerCase("en-US"));
    if (!path.startsWith("assets/") || SOURCE_METADATA.has(path)) continue;
    const kind = sourceKind(path);
    if (!kind) {
      issues.push(issue("W-ASSET-001", "warning", `assets配下ですが認識できないフォルダです: ${path}`, { path }));
      continue;
    }
    const mime = mimeForPath(path);
    const fileName = path.split("/").at(-1) ?? path;
    if (fileName === ".gitkeep") continue;
    if (!mime) {
      issues.push(issue("E-ASSET-002", "error", `対応していない素材形式です: ${path}`, { path }));
      continue;
    }
    if (!mimeMatchesKind(mime, kind)) {
      issues.push(issue("E-ASSET-006", "error", `${kind}フォルダに置けない素材形式です: ${path}`, { path }));
      continue;
    }
    const stem = fileName.replace(/\.[^.]+$/, "");
    const assetId = slugId(stem, "asset");
    const runtime = runtimePath(path, kind);
    const existing = sourceById.get(assetId);
    if (existing) {
      issues.push(issue("E-ASSET-003", "error", `素材IDが重複しています: ${assetId}`, { path, asset_id: assetId }));
      continue;
    }
    sourceById.set(assetId, { path, kind });
    assets.push({ asset_id: assetId, path: runtime, kind, mime, bytes: file.bytes.byteLength, sha256: await sha256(file.bytes) });
  }

  const refs = collectReferences(scenario);
  const slotsById = new Map<string, AssetSlot>();
  for (const ref of refs) {
    const existing = slotsById.get(ref.id);
    if (existing) {
      if (existing.kind !== ref.kind) issues.push(issue("E-ASSET-004", "error", `同じ素材IDに異なる種類が指定されています: ${ref.id}`, { asset_id: ref.id, node_id: ref.nodeId }));
      continue;
    }
    const actual = sourceById.get(ref.id);
    const slot: AssetSlot = {
      slot_id: ref.id,
      kind: ref.kind,
      label: `${ref.kind === "voice" ? "音声" : ref.kind === "se" ? "SE" : ref.kind === "bgm" ? "BGM" : "差し絵"} ${ref.id}`,
      target_path: actual?.path ?? defaultSourcePath(ref.kind, ref.id),
      required: true,
      status: actual ? "present" : "missing",
      asset_id: actual ? ref.id : undefined,
      source_node_id: ref.nodeId
    };
    slotsById.set(ref.id, slot);
    if (!actual) issues.push(issue("E-ASSET-001", "error", `参照されている素材が見つかりません: ${ref.id}`, { slot_id: ref.id, asset_id: ref.id, node_id: ref.nodeId, path: slot.target_path }));
  }
  const referenced = new Set(refs.map((ref) => ref.id));
  for (const asset of assets) {
    if (!referenced.has(asset.asset_id) && asset.asset_id !== "cover") issues.push(issue("W-ASSET-002", "warning", `台本から参照されていない素材です: ${asset.asset_id}`, { asset_id: asset.asset_id, path: asset.path }));
  }

  return {
    workId,
    title,
    workVersion,
    scenario,
    assetsFile: { schema_version: "1.0", assets },
    assetManifest: { schema_version: "1.0", assets, slots: [...slotsById.values()] },
    issues
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function buildPneManifest(scanned: ScannedProject, input: PneProjectInput): PneManifest {
  const releaseId = slugId(input.releaseId ?? `${scanned.workId}-release-${scanned.workVersion}`, "release");
  const requiredFeatures = new Set<string>(["history.v1"]);
  if (scanned.scenario.nodes.some((node) => node.type === "reaction_prompt")) requiredFeatures.add("reaction.v1");
  const timelineDuration = Math.max(0, ...scanned.scenario.nodes.map((node) => node.timeline_ms));
  return {
    format: "pne",
    format_version: "1.0.0",
    work_id: scanned.workId,
    release_id: releaseId,
    work_version: scanned.workVersion,
    content_graph_hash: "0".repeat(64),
    title: scanned.title,
    entry_node: scanned.scenario.entry_node,
    timeline_duration_ms: timelineDuration,
    runtime_state_schema: runtimeStateSchema(input.statekitPack),
    scenario_path: "scenario.json",
    assets_path: "assets.json",
    required_features: [...requiredFeatures],
    capabilities: {
      web_playable: true,
      desktop_playable: true,
      name_call_supported: false,
      mobile_transfer_supported: false
    },
    license: input.license ?? defaultLicense()
  };
}

function packageEntries(manifest: PneManifest, scenario: Scenario, assetsFile: AssetsFile, license: PneLicense, files: ProjectFile[]): ZipEntry[] {
  const entries: ZipEntry[] = [
    { path: "manifest.json", bytes: jsonBytes(manifest) },
    { path: "scenario.json", bytes: jsonBytes(scenario) },
    { path: "assets.json", bytes: jsonBytes(assetsFile) },
    { path: "license.json", bytes: jsonBytes(license) }
  ];
  const actualPaths = new Map(files.map((file) => [normalizePath(file.path), file.bytes]));
  for (const asset of assetsFile.assets) {
    const sourcePath = [...actualPaths.keys()].find((path) => {
      const kind = sourceKind(path);
      return kind && runtimePath(path, kind) === asset.path;
    });
    if (sourcePath) entries.push({ path: asset.path, bytes: actualPaths.get(sourcePath)! });
  }
  return entries;
}

export async function buildPnePackage(input: PneProjectInput): Promise<BuiltPnePackage> {
  const scanned = await scanProject(input);
  const errors = scanned.issues.filter((item) => item.level === "error");
  if (errors.length) throw new PnePackError(scanned.issues);
  let manifest = buildPneManifest(scanned, input);
  manifest = { ...manifest, content_graph_hash: await calculateContentGraphHash(manifest, scanned.scenario) };
  try {
    validatePackageContract(manifest, scanned.assetsFile, scanned.scenario);
  } catch (error) {
    const problems = (error as { problems?: string[] }).problems ?? [String(error)];
    throw new PnePackError([...scanned.issues, ...problems.map((message) => issue("E-PACK-001", "error", message))]);
  }
  const license = manifest.license ?? defaultLicense();
  return {
    archive: writeStoredZip(packageEntries(manifest, scanned.scenario, scanned.assetsFile, license, input.files)),
    manifest,
    scenario: scanned.scenario,
    assetsFile: scanned.assetsFile,
    issues: scanned.issues
  };
}

export async function buildEditablePnepack(input: PneProjectInput): Promise<BuiltPnepack> {
  const scanned = await scanProject(input);
  const license = input.license ?? defaultLicense();
  const manifest: PnepackManifest = {
    format: "pnepack",
    format_version: "1.0.0",
    package_kind: "editable",
    work_id: scanned.workId,
    title: scanned.title,
    work_version: scanned.workVersion,
    source_path: "pne_statekit_pack.json",
    asset_manifest_path: "asset_manifest.json",
    license_path: "license.json",
    license
  };
  const entries: ZipEntry[] = [
    { path: "manifest.json", bytes: jsonBytes(manifest) },
    { path: "pne_statekit_pack.json", bytes: jsonBytes(input.statekitPack) },
    { path: "asset_manifest.json", bytes: jsonBytes(scanned.assetManifest) },
    { path: "license.json", bytes: jsonBytes(license) }
  ];
  const actualPaths = new Map(input.files.map((file) => [normalizePath(file.path), file.bytes]));
  for (const [path, bytes] of actualPaths) if (path.startsWith("assets/") && path.split("/").at(-1) !== ".gitkeep") entries.push({ path, bytes });
  return { archive: writeStoredZip(entries), manifest, assetManifest: scanned.assetManifest, issues: scanned.issues };
}

export interface ZipEntry { path: string; bytes: Uint8Array }

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array { return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]); }
function u32(value: number): Uint8Array { return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]); }
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

export function writeStoredZip(entries: ZipEntry[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const path = normalizePath(entry.path);
    const name = new TextEncoder().encode(path);
    const checksum = crc32(entry.bytes);
    if (entry.bytes.byteLength > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP64 is required for this package");
    const header = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(checksum), u32(entry.bytes.byteLength), u32(entry.bytes.byteLength), u16(name.byteLength), u16(0), name
    ]);
    local.push(header, entry.bytes);
    const centralHeader = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0), u32(checksum), u32(entry.bytes.byteLength), u32(entry.bytes.byteLength), u16(name.byteLength), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
    ]);
    central.push(centralHeader);
    offset += header.byteLength + entry.bytes.byteLength;
  }
  const localBytes = concatBytes(local);
  const centralBytes = concatBytes(central);
  const end = concatBytes([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBytes.byteLength), u32(localBytes.byteLength), u16(0)
  ]);
  return concatBytes([localBytes, centralBytes, end]);
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error("truncated ZIP header");
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error("truncated ZIP header");
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function signatureAt(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

/**
 * Reads the stored ZIP variant emitted by this package.
 *
 * P.N.E. archives intentionally use a small, deterministic subset of ZIP:
 * UTF-8 names, no compression, no data descriptors, and no ZIP64. Keeping a
 * reader here lets the packer verify its own output before handing it to the
 * user and gives future CLI/Tauri integrations one common inspection path.
 */
export function readStoredZip(bytes: Uint8Array): ZipEntry[] {
  const minimumEnd = 22;
  const searchStart = Math.max(0, bytes.byteLength - (minimumEnd + 0xffff));
  let endOffset = -1;
  for (let offset = bytes.byteLength - minimumEnd; offset >= searchStart; offset -= 1) {
    if (signatureAt(bytes, offset, [0x50, 0x4b, 0x05, 0x06])) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("ZIP end-of-central-directory record was not found");

  const entryCount = readU16(bytes, endOffset + 10);
  const centralSize = readU32(bytes, endOffset + 12);
  const centralOffset = readU32(bytes, endOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (centralOffset + centralSize > endOffset) throw new Error("ZIP central directory is outside the archive");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (!signatureAt(bytes, cursor, [0x50, 0x4b, 0x01, 0x02])) throw new Error("invalid ZIP central directory entry");
    const flags = readU16(bytes, cursor + 8);
    const method = readU16(bytes, cursor + 10);
    const expectedCrc = readU32(bytes, cursor + 16);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    const nameStart = cursor + 46;
    const nextCursor = nameStart + nameLength + extraLength + commentLength;
    if (nextCursor > centralOffset + centralSize) throw new Error("truncated ZIP central directory entry");
    if ((flags & 0x08) !== 0) throw new Error("ZIP data descriptors are not supported");
    if (method !== 0) throw new Error("compressed ZIP entries are not supported");
    if (compressedSize !== uncompressedSize) throw new Error("ZIP entry size mismatch");

    let path: string;
    try { path = normalizePath(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))); }
    catch (error) { throw new Error(`invalid ZIP entry path: ${String(error)}`); }
    if (paths.has(path)) throw new Error(`duplicate ZIP entry: ${path}`);
    paths.add(path);

    if (!signatureAt(bytes, localOffset, [0x50, 0x4b, 0x03, 0x04])) throw new Error(`invalid ZIP local header: ${path}`);
    const localNameLength = readU16(bytes, localOffset + 26);
    const localExtraLength = readU16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw new Error(`truncated ZIP entry: ${path}`);
    const data = bytes.slice(dataStart, dataEnd);
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP checksum mismatch: ${path}`);
    entries.push({ path, bytes: data });
    cursor = nextCursor;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch");
  return entries;
}

export interface InspectedPneArchive {
  manifest: PneManifest;
  scenario: Scenario;
  assetsFile: AssetsFile;
  entries: ZipEntry[];
}

function requiredJson(entries: ZipEntry[], path: string): unknown {
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`required archive entry is missing: ${path}`);
  try { return JSON.parse(new TextDecoder().decode(entry.bytes)) as unknown; }
  catch (error) { throw new Error(`invalid JSON in ${path}: ${String(error)}`); }
}

/** Re-reads and validates a completed .pne archive, including asset hashes. */
export async function inspectPneArchive(bytes: Uint8Array): Promise<InspectedPneArchive> {
  const entries = readStoredZip(bytes);
  const manifest = requiredJson(entries, "manifest.json") as PneManifest;
  const scenario = requiredJson(entries, "scenario.json") as Scenario;
  const assetsFile = requiredJson(entries, "assets.json") as AssetsFile;
  try { validatePackageContract(manifest, assetsFile, scenario); }
  catch (error) {
    const problems = (error as { problems?: string[] }).problems ?? [String(error)];
    throw new PnePackError(problems.map((message) => issue("E-PACK-002", "error", message)));
  }
  for (const asset of assetsFile.assets) {
    const entry = entries.find((candidate) => candidate.path === asset.path);
    if (!entry) throw new PnePackError([issue("E-PACK-003", "error", `マニフェストの素材がアーカイブにありません: ${asset.asset_id}`, { asset_id: asset.asset_id, path: asset.path })]);
    if (entry.bytes.byteLength !== asset.bytes) throw new PnePackError([issue("E-PACK-004", "error", `素材サイズが一致しません: ${asset.asset_id}`, { asset_id: asset.asset_id, path: asset.path })]);
    const actualHash = await sha256(entry.bytes);
    if (actualHash !== asset.sha256) throw new PnePackError([issue("E-PACK-005", "error", `素材SHA-256が一致しません: ${asset.asset_id}`, { asset_id: asset.asset_id, path: asset.path })]);
  }
  return { manifest, scenario, assetsFile, entries };
}

export function canonicalManifestJson(manifest: PneManifest): string {
  return canonicalJson(manifest);
}
