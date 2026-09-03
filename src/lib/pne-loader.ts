import { inspectPneArchive, type InspectedPneArchive } from "../../packages/pne-pack/src";
import type { PneAsset, PneVoiceProfile } from "../../packages/pne-schema/src";
import type { LocalNameVoiceConfig, LocalWork } from "../types";

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "時間未設定";
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  return `約${minutes}分`;
}

function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))}KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
}

function assetUrl(bytes: Uint8Array, mime: string): string {
  const copy = bytes.slice();
  return URL.createObjectURL(new Blob([copy.buffer as ArrayBuffer], { type: mime }));
}

function makeAssetUrls(inspected: InspectedPneArchive): {
  urls: Record<string, string>;
  kinds: Record<string, string>;
  assets: PneAsset[];
} {
  const entryByPath = new Map(inspected.entries.map((entry) => [entry.path, entry]));
  const urls: Record<string, string> = {};
  const kinds: Record<string, string> = {};
  const created: string[] = [];
  try {
    for (const asset of inspected.assetsFile.assets) {
      const entry = entryByPath.get(asset.path);
      if (!entry) throw new Error(`素材がアーカイブにありません: ${asset.asset_id}`);
      const url = assetUrl(entry.bytes, asset.mime);
      created.push(url);
      // Scenario clips use asset_id. Keeping path aliases also supports older
      // packs that stored the runtime path directly in audio.sequence.
      urls[asset.asset_id] = url;
      urls[asset.path] = url;
      kinds[asset.asset_id] = asset.kind;
      kinds[asset.path] = asset.kind;
    }
    return { urls, kinds, assets: inspected.assetsFile.assets };
  } catch (error) {
    created.forEach((url) => URL.revokeObjectURL(url));
    throw error;
  }
}

function makeNameVoiceConfig(inspected: InspectedPneArchive, urls: Record<string, string>): LocalNameVoiceConfig | undefined {
  const nameVoice = inspected.manifest.name_voice;
  if (!nameVoice) return undefined;

  const voiceProfiles = Object.fromEntries(nameVoice.voice_profiles.map((profile: PneVoiceProfile) => {
    const referenceId = profile.references ? Object.values(profile.references)[0] : undefined;
    const reference = referenceId ? urls[referenceId] : undefined;
    return [profile.voice_id, {
      reference: reference ?? "",
      reference_version: profile.model_version,
      enabled: Boolean(reference)
    }];
  }));
  return {
    preview_slot_id: nameVoice.preview_slot_id,
    voice_profiles: voiceProfiles
  };
}

/** Convert a verified archive into the runtime work model used by the UI. */
export function localWorkFromPneArchive(inspected: InspectedPneArchive, sourceName = "work.pne"): LocalWork {
  const { urls, kinds, assets } = makeAssetUrls(inspected);
  const coverAsset = assets.find((asset) => asset.asset_id === "cover")
    ?? assets.find((asset) => asset.kind === "image");
  const totalBytes = assets.reduce((total, asset) => total + asset.bytes, 0);
  const title = inspected.manifest.title || sourceName.replace(/\.pne$/i, "") || "無題のP.N.E.作品";
  return {
    workId: inspected.manifest.work_id,
    version: inspected.manifest.work_version,
    title,
    author: "ローカルパッケージ",
    description: "完成版 .pne パッケージから読み込んだ作品です。",
    cover: coverAsset ? urls[coverAsset.asset_id] : "/logo.PNG",
    durationLabel: formatDuration(inspected.manifest.timeline_duration_ms),
    durationMs: inspected.manifest.timeline_duration_ms,
    sizeLabel: formatSize(totalBytes),
    state: "READY",
    capabilities: inspected.manifest.capabilities,
    scenario: inspected.scenario,
    nameSlots: inspected.manifest.name_voice?.slots ?? [],
    nameVoice: makeNameVoiceConfig(inspected, urls),
    assetUrls: urls,
    assetKinds: kinds
  };
}

export async function loadPnePackageBytes(bytes: Uint8Array, sourceName = "work.pne"): Promise<LocalWork> {
  const inspected = await inspectPneArchive(bytes);
  return localWorkFromPneArchive(inspected, sourceName);
}

export async function loadPnePackageFile(file: File): Promise<LocalWork> {
  return loadPnePackageBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

