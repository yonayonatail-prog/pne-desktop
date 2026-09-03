import type { LocalWork, NameProfile } from "../types";
import { playAudioSource, stopAudioPlayback, unlockAudioPlayback } from "./audio-playback";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
// The source module is the audited browser mock implementation. Its public API
// is described below because it is intentionally kept as plain ESM.
// @ts-expect-error The vendored mock module has no TypeScript declaration.
import * as bundledNameVoiceModule from "../name-voice/pne-name-voice.mjs";
const DEFAULT_VOICE_ID = "hiiro";
const DEFAULT_REFERENCE_URL = "/voice-reference/hiiro.ogg";

export const IRODORI_MODEL_BYTES = 1_255_448_441;

export type IrodoriModelState = "NOT_INSTALLED" | "PARTIAL" | "READY";

export interface NameVoiceProgress {
  stage: "scanning" | "cache-check" | "loading-model" | "generating" | "cutting" | "saving" | "ready" | "partial";
  progress: number;
  loadedBytes?: number;
  totalBytes?: number;
  component?: string;
  cached?: boolean;
  source?: "bundled" | "cache" | "remote";
  callReading?: string;
}

interface ManagerResult {
  ready: boolean;
  partial: boolean;
  preview?: { blob?: Blob };
}

interface NameVoiceManagerLike {
  prepare(input: { pack: unknown; profile: { name: string; reading: string } }): Promise<ManagerResult>;
  cancel(): void;
  get(input: { voiceId: string; form: NameProfile["form"] }): { blob?: Blob } | null;
}

interface NameVoiceModule {
  NameVoiceManager: new (options: { onState: (event: Record<string, unknown>) => void }) => NameVoiceManagerLike;
  setBundledAssetUrls?: (urls: { modelBase: string; runtimeBase: string; tokenizerPath: string }) => void;
}

export interface PreparedNameVoiceTransferClip {
  clipId: string;
  slotIds: string[];
  mime: "audio/wav";
  durationMs: number;
  audioBytes: number[];
}

let modulePromise: Promise<NameVoiceModule> | null = null;
let manager: NameVoiceManagerLike | null = null;
let activeListener: ((event: NameVoiceProgress) => void) | null = null;
let preparedSignature = "";
let bundledAssetUrlsPromise: Promise<void> | null = null;

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function configureBundledAssetUrls(): Promise<void> {
  if (!isTauri()) return;
  if (!bundledAssetUrlsPromise) {
    bundledAssetUrlsPromise = (async () => {
      const module = await loadModule();
      try {
        const resourcePath = await resolveResource("vendor/irodori-tts-webgpu");
        const resourceBase = `${convertFileSrc(resourcePath).replace(/\/$/, "")}/`;
        module.setBundledAssetUrls?.({
          modelBase: `${resourceBase}models/b75a9bbf2c10e12682d37e91e0efaf6d4e54bd29/onnx_fp16/`,
          runtimeBase: `${resourceBase}runtime/`,
          tokenizerPath: `${resourceBase}tokenizer/`
        });
      } catch (error) {
        if (!import.meta.env.DEV) throw error;
      }
    })();
  }
  await bundledAssetUrlsPromise;
}

function loadModule(): Promise<NameVoiceModule> {
  if (!modulePromise) {
    modulePromise = Promise.resolve(bundledNameVoiceModule as unknown as NameVoiceModule);
  }
  return modulePromise;
}

function normalizeProgress(event: Record<string, unknown>): NameVoiceProgress {
  const rawProgress = Number(event.overallProgress ?? event.progress ?? 0);
  return {
    stage: String(event.state ?? "scanning") as NameVoiceProgress["stage"],
    progress: Math.max(0, Math.min(1, Number.isFinite(rawProgress) ? rawProgress : 0)),
    loadedBytes: typeof event.loadedBytes === "number" ? event.loadedBytes : undefined,
    totalBytes: typeof event.totalBytes === "number" ? event.totalBytes : undefined,
    component: typeof event.component === "string" ? event.component : undefined,
    cached: typeof event.cached === "boolean" ? event.cached : undefined,
    source: event.source === "bundled" || event.source === "cache" || event.source === "remote" ? event.source : undefined,
    callReading: typeof event.callReading === "string" ? event.callReading : undefined
  };
}

async function getManager(listener?: (event: NameVoiceProgress) => void): Promise<NameVoiceManagerLike> {
  activeListener = listener ?? activeListener;
  if (!manager) {
    const module = await loadModule();
    manager = new module.NameVoiceManager({ onState: (event) => activeListener?.(normalizeProgress(event)) });
  }
  return manager;
}

function profileSignature(work: LocalWork, profile: NameProfile): string {
  return JSON.stringify([
    work.workId,
    work.version,
    profile.reading.normalize("NFKC").trim(),
    profile.form,
    work.nameSlots.map((slot) => [slot.slot_id, slot.voice_id ?? DEFAULT_VOICE_ID, slot.form ?? "profile"]),
    work.nameVoice?.voice_profiles ?? {}
  ]);
}

function resolvedForm(slot: LocalWork["nameSlots"][number], profile: NameProfile): NameProfile["form"] {
  return slot.form && slot.form !== "profile" ? slot.form : profile.form;
}

function buildNameVoicePack(work: LocalWork, profile: NameProfile) {
  const voiceProfiles = work.nameVoice?.voice_profiles ?? {
    [DEFAULT_VOICE_ID]: { reference: DEFAULT_REFERENCE_URL, reference_version: "hiiro-n1-02-ogg-v1", enabled: true }
  };
  const slots = work.nameSlots.length ? work.nameSlots : [{
    slot_id: "name.start.whisper",
    fallback_clip_id: "fallback",
    fallback_text: "あなた"
  }];
  const previewSlot = slots.find((slot) => slot.slot_id === work.nameVoice?.preview_slot_id) ?? slots[0];
  return {
    start_screen: {
      name_voice: {
        voice_id: previewSlot.voice_id ?? DEFAULT_VOICE_ID,
        preview_form: resolvedForm(previewSlot, profile)
      }
    },
    voice_profiles: voiceProfiles,
    nodes: slots.map((slot) => ({
      id: `name.${slot.slot_id}`,
      voice_id: slot.voice_id ?? DEFAULT_VOICE_ID,
      text: `{{name:${resolvedForm(slot, profile)}}}`
    }))
  };
}

export async function prepareNameVoice(
  work: LocalWork,
  profile: NameProfile,
  onProgress: (event: NameVoiceProgress) => void
): Promise<void> {
  await configureBundledAssetUrls();
  const instance = await getManager(onProgress);
  const result = await instance.prepare({
    pack: buildNameVoicePack(work, profile),
    profile: { name: profile.displayName, reading: profile.reading }
  });
  if (!result.ready) throw new Error("生成した名前音声を取得できませんでした");
  preparedSignature = profileSignature(work, profile);
}

export function cancelNameVoice(): void {
  manager?.cancel();
  stopAudioPlayback();
  preparedSignature = "";
}

function preparedBlob(work: LocalWork, profile: NameProfile, slotId: string): Blob | null {
  if (!manager || preparedSignature !== profileSignature(work, profile)) return null;
  const slot = work.nameSlots.find((candidate) => candidate.slot_id === slotId);
  if (!slot) return null;
  const voiceId = slot.voice_id ?? DEFAULT_VOICE_ID;
  return manager.get({ voiceId, form: resolvedForm(slot, profile) })?.blob ?? null;
}

function wavDurationMs(bytes: Uint8Array): number {
  if (bytes.byteLength < 44) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  const bytesPerSample = channels * (bitsPerSample / 8);
  if (!channels || !sampleRate || !bytesPerSample) return 0;
  return Math.round(((bytes.byteLength - 44) / bytesPerSample / sampleRate) * 1000);
}

export async function getPreparedNameVoiceTransferClips(
  work: LocalWork,
  profile: NameProfile
): Promise<PreparedNameVoiceTransferClip[]> {
  const grouped = new Map<string, { blob: Blob; slotIds: string[] }>();
  for (const slot of work.nameSlots) {
    const voiceId = slot.voice_id ?? DEFAULT_VOICE_ID;
    const form = resolvedForm(slot, profile);
    const key = `${voiceId}\u0000${form}`;
    const blob = preparedBlob(work, profile, slot.slot_id);
    if (!blob) throw new Error("転送する名前音声が見つかりません。名前画面からもう一度生成してください。");
    const current = grouped.get(key);
    if (current) current.slotIds.push(slot.slot_id);
    else grouped.set(key, { blob, slotIds: [slot.slot_id] });
  }

  const clips: PreparedNameVoiceTransferClip[] = [];
  let index = 0;
  for (const { blob, slotIds } of grouped.values()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    clips.push({
      clipId: `clip-${String(++index).padStart(2, "0")}-${crypto.randomUUID()}`,
      slotIds,
      mime: "audio/wav",
      durationMs: wavDurationMs(bytes),
      audioBytes: Array.from(bytes)
    });
  }
  return clips;
}

export async function previewNameVoice(work: LocalWork, profile: NameProfile): Promise<void> {
  const slotId = work.nameVoice?.preview_slot_id ?? work.nameSlots[0]?.slot_id;
  if (!slotId) throw new Error("名前音声スロットが定義されていません");
  const blob = preparedBlob(work, profile, slotId);
  if (!blob) throw new Error("名前音声がまだ準備されていません");
  await playAudioSource(blob);
}

export async function unlockNameVoiceAudio(): Promise<void> {
  await unlockAudioPlayback();
}

export async function playPreparedNameVoice(work: LocalWork, profile: NameProfile, slotId: string): Promise<boolean> {
  const blob = preparedBlob(work, profile, slotId);
  if (!blob) return false;
  return playAudioSource(blob);
}

export async function getIrodoriModelState(): Promise<IrodoriModelState> {
  // The model is part of the release asset set; there is no download/cache
  // state to scan before generation begins.
  return "READY";
}

export function nameVoiceErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "WEBGPU_UNAVAILABLE") return "このPCではWebGPUを利用できません。WebView2とGPUドライバーを更新してください。";
  if (code === "MODEL_DOWNLOAD_FAILED") return "アプリに同梱された音声モデルを読み込めませんでした。アプリを再インストールして、もう一度お試しください。";
  if (["RUNTIME_LOAD_FAILED", "MODEL_INITIALIZATION_FAILED", "TOKENIZER_LOAD_FAILED"].includes(code)) return "Irodori音声エンジンを初期化できませんでした。診断画面と開発者コンソールを確認してください。";
  if (code === "REFERENCE_LOAD_FAILED") return "ヒイロの参照音声を読み込めませんでした。";
  if (typeof error === "object" && error && "name" in error && (error as { name: unknown }).name === "AbortError") return "キャンセルしました";
  return error instanceof Error ? error.message : "名前音声を生成できませんでした";
}
