import type { GenerationRoundRecord, GenerationUnitRecord, VoiceCandidateRecord, VoiceGenerationManifest } from "../types";
import type { VoiceCandidateAudio, VoiceRoundWithAudio } from "./types";

const DB_NAME = "pne-voice-generation-v1";
const STORE_NAME = "audio";
const memoryBlobs = new Map<string, Blob>();

export function voiceAudioKey(projectId: string, candidateId: string, kind: "raw" | "trimmed"): string {
  return `${projectId}:${candidateId}:${kind}`;
}

function manifestKey(projectId: string): string {
  return `pne.voice-generation.${projectId}`;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function putBlob(key: string, blob: Blob): Promise<void> {
  memoryBlobs.set(key, blob);
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(blob, key);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); resolve(); };
  });
}

async function getBlob(key: string | undefined): Promise<Blob | undefined> {
  if (!key) return undefined;
  const inMemory = memoryBlobs.get(key);
  if (inMemory) return inMemory;
  const database = await openDatabase();
  if (!database) return undefined;
  return new Promise((resolve) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => { database.close(); resolve(request.result instanceof Blob ? request.result : undefined); };
    request.onerror = () => { database.close(); resolve(undefined); };
  });
}

/** Load a generated clip for the authoring preview or the local Runtime. */
export async function loadVoiceAudio(key: string | undefined): Promise<Blob | undefined> {
  return getBlob(key);
}

export function emptyVoiceGenerationManifest(projectId: string, modelId = "irodori-tts-500m-v3-fp16"): VoiceGenerationManifest {
  return { manifest_version: "1.0.0", project_id: projectId, model_id: modelId, num_steps: 34, units: [], updated_at: new Date().toISOString() };
}

export function loadVoiceGenerationManifest(projectId: string): VoiceGenerationManifest {
  try {
    const raw = localStorage.getItem(manifestKey(projectId));
    if (raw) return JSON.parse(raw) as VoiceGenerationManifest;
  } catch { /* localStorage can be unavailable in private/browser test contexts */ }
  return emptyVoiceGenerationManifest(projectId);
}

export function saveVoiceGenerationManifest(manifest: VoiceGenerationManifest): void {
  const next = { ...manifest, updated_at: new Date().toISOString() };
  try { localStorage.setItem(manifestKey(manifest.project_id), JSON.stringify(next)); } catch { /* IndexedDB remains available for audio */ }
}

function serializeCandidate(candidate: VoiceCandidateAudio): VoiceCandidateRecord {
  const { raw_audio: _raw, trimmed_audio: _trimmed, ...metadata } = candidate;
  return metadata;
}

export function serializeRound(round: VoiceRoundWithAudio): GenerationRoundRecord {
  return { ...round, candidates: round.candidates.map(serializeCandidate) as [VoiceCandidateRecord, VoiceCandidateRecord, VoiceCandidateRecord] };
}

export async function persistVoiceRound(projectId: string, round: VoiceRoundWithAudio, previous?: VoiceGenerationManifest): Promise<VoiceGenerationManifest> {
  for (const candidate of round.candidates) {
    if (candidate.raw_audio) await putBlob(voiceAudioKey(projectId, candidate.candidate_id, "raw"), candidate.raw_audio);
    if (candidate.trimmed_audio) await putBlob(voiceAudioKey(projectId, candidate.candidate_id, "trimmed"), candidate.trimmed_audio);
  }
  const manifest = previous ? structuredClone(previous) : emptyVoiceGenerationManifest(projectId);
  const unit = manifest.units.find((entry) => entry.generation_unit_id === round.generation_unit_id) || {
    generation_unit_id: round.generation_unit_id,
    source_line_ids: [round.generation_unit_id.replace(/^unit_/, "")],
    rounds: []
  } satisfies GenerationUnitRecord;
  const record = serializeRound({
    ...round,
    candidates: round.candidates.map((candidate) => ({
      ...candidate,
      raw_audio_key: candidate.raw_audio ? voiceAudioKey(projectId, candidate.candidate_id, "raw") : candidate.raw_audio_key,
      trimmed_audio_key: candidate.trimmed_audio ? voiceAudioKey(projectId, candidate.candidate_id, "trimmed") : candidate.trimmed_audio_key
    })) as [VoiceCandidateAudio, VoiceCandidateAudio, VoiceCandidateAudio]
  });
  const existingIndex = unit.rounds.findIndex((entry) => entry.round_id === record.round_id);
  if (existingIndex >= 0) unit.rounds[existingIndex] = record;
  else unit.rounds.push(record);
  if (!manifest.units.includes(unit)) manifest.units.push(unit);
  saveVoiceGenerationManifest(manifest);
  return manifest;
}

export function selectVoiceCandidate(manifest: VoiceGenerationManifest, unitId: string, roundId: string, candidateId: string): VoiceGenerationManifest {
  const next = structuredClone(manifest);
  const unit = next.units.find((entry) => entry.generation_unit_id === unitId);
  if (!unit || !unit.rounds.some((round) => round.round_id === roundId && round.candidates.some((candidate) => candidate.candidate_id === candidateId))) {
    throw new Error("採用対象の音声候補が見つかりません");
  }
  unit.selected_round_id = roundId;
  unit.selected_candidate_id = candidateId;
  unit.rounds.forEach((round) => { if (round.status === "selected") round.status = "superseded"; });
  const selectedRound = unit.rounds.find((round) => round.round_id === roundId);
  if (selectedRound) selectedRound.status = "selected";
  saveVoiceGenerationManifest(next);
  return next;
}

export async function hydrateVoiceRound(record: GenerationRoundRecord): Promise<VoiceRoundWithAudio> {
  const candidates = await Promise.all(record.candidates.map(async (candidate) => ({
    ...candidate,
    raw_audio: await getBlob(candidate.raw_audio_key),
    trimmed_audio: await getBlob(candidate.trimmed_audio_key)
  })));
  return { ...record, candidates: candidates as [VoiceCandidateAudio, VoiceCandidateAudio, VoiceCandidateAudio] };
}
