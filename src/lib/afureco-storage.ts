import type { Take } from "../afureco/types";

const DB_NAME = "pne-afureco-v1";
const DB_VERSION = 1;
const TAKE_STORE = "takes";
const AUDIO_STORE = "audio";

interface AudioRecord { fileId: string; blob: Blob; }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TAKE_STORE)) database.createObjectStore(TAKE_STORE, { keyPath: "takeId" });
      if (!database.objectStoreNames.contains(AUDIO_STORE)) database.createObjectStore(AUDIO_STORE, { keyPath: "fileId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("アフレコ保存領域を開けませんでした"));
  });
}

export async function saveTake(take: Take, audio: Blob): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([TAKE_STORE, AUDIO_STORE], "readwrite");
    transaction.objectStore(TAKE_STORE).put(take);
    transaction.objectStore(AUDIO_STORE).put({ fileId: take.fileId, blob: audio } satisfies AudioRecord);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("テイクを保存できませんでした"));
    transaction.onabort = () => reject(transaction.error ?? new Error("テイク保存が中断されました"));
  }).finally(() => database.close());
}

export async function listTakes(projectId: string): Promise<Take[]> {
  const database = await openDatabase();
  return new Promise<Take[]>((resolve, reject) => {
    const request = database.transaction(TAKE_STORE, "readonly").objectStore(TAKE_STORE).getAll();
    request.onsuccess = () => {
      database.close();
      resolve((request.result as Take[]).filter((take) => take.projectId === projectId).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)));
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("テイク一覧を読み込めませんでした"));
    };
  });
}

export async function loadTakeAudio(fileId: string): Promise<Blob | null> {
  const database = await openDatabase();
  return new Promise<Blob | null>((resolve, reject) => {
    const request = database.transaction(AUDIO_STORE, "readonly").objectStore(AUDIO_STORE).get(fileId);
    request.onsuccess = () => {
      database.close();
      resolve((request.result as AudioRecord | undefined)?.blob ?? null);
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("録音データを読み込めませんでした"));
    };
  });
}
