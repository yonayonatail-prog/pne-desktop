import type { LocalWork, NameProfile } from "../types";
import { playAudioSource, stopAudioPlayback, unlockAudioPlayback } from "./audio-playback";
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
}

let modulePromise: Promise<NameVoiceModule> | null = null;
let manager: NameVoiceManagerLike | null = null;
let activeListener: ((event: NameVoiceProgress) => void) | null = null;
let preparedSignature = "";

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
