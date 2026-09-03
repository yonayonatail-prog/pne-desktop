import { releaseMicrophoneForPlayback } from "./microphone";

const UNLOCK_SOURCE = "/senpai-audio/START_HEADPHONES.ogg";

let audioElement: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;
let activeFinish: ((played: boolean) => void) | null = null;
let requestId = 0;

function getAudioElement(): HTMLAudioElement {
  if (!audioElement) {
    audioElement = new Audio();
    audioElement.preload = "auto";
    audioElement.dataset.pneAudio = "main";
    audioElement.hidden = true;
    document.body.appendChild(audioElement);
  }
  return audioElement;
}

function releaseObjectUrl(): void {
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = null;
}

function playbackVolume(): number {
  return Math.min(1, Math.max(0, Number(localStorage.getItem("pne.volume") ?? 82) / 100));
}

export function stopAudioPlayback(): void {
  requestId += 1;
  activeFinish?.(false);
  activeFinish = null;
  const audio = audioElement;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  releaseObjectUrl();
}

export async function unlockAudioPlayback(): Promise<void> {
  await releaseMicrophoneForPlayback();
  stopAudioPlayback();
  const audio = getAudioElement();
  const previousMuted = audio.muted;
  audio.muted = true;
  audio.src = UNLOCK_SOURCE;
  try {
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
  } catch (error) {
    throw audioPlaybackError(error, audio);
  } finally {
    audio.muted = previousMuted;
    audio.removeAttribute("src");
    audio.load();
  }
}

export async function playAudioSource(source: string | Blob): Promise<boolean> {
  const microphoneRelease = releaseMicrophoneForPlayback();
  if (microphoneRelease) await microphoneRelease;
  stopAudioPlayback();
  const currentRequest = requestId;
  const audio = getAudioElement();
  audio.muted = false;
  audio.volume = playbackVolume();
  if (source instanceof Blob) {
    activeObjectUrl = URL.createObjectURL(source);
    audio.src = activeObjectUrl;
  } else {
    audio.src = source;
  }

  return new Promise<boolean>((resolve, reject) => {
    let finished = false;
    const finish = (played: boolean) => {
      if (finished) return;
      finished = true;
      audio.onended = null;
      audio.onerror = null;
      if (activeFinish === finish) activeFinish = null;
      releaseObjectUrl();
      resolve(played && currentRequest === requestId);
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      activeFinish = null;
      audio.onended = null;
      audio.onerror = null;
      releaseObjectUrl();
      reject(audioPlaybackError(error, audio));
    };

    // Register listeners before play(). This matters for Blob-backed WAVs:
    // WebView2 can dispatch loaded/error/ended synchronously when the source
    // is already available, and a short clip can otherwise be missed.
    activeFinish = finish;
    audio.onended = () => finish(true);
    audio.onerror = () => fail(null);

    try {
      audio.load();
      // Call play without an intervening await so a direct button click keeps
      // its transient user activation in Windows WebView2.
      const playResult = audio.play();
      void Promise.resolve(playResult).catch(fail);
    } catch (error) {
      fail(error);
    }
  });
}

function audioPlaybackError(error: unknown, audio: HTMLAudioElement): Error {
  const mediaCode = audio.error?.code;
  const causeName = error instanceof DOMException ? error.name : "";
  let message = "音声を再生できませんでした。出力先と音量を確認してください。";
  if (causeName === "NotAllowedError") message = "ブラウザに音声再生を止められました。「音声を再試行」を押してください。";
  else if (causeName === "NotSupportedError" || mediaCode === 4) message = "音声形式を再生できませんでした。";
  else if (mediaCode === 2) message = "音声ファイルを読み込めませんでした。";
  const playbackError = new Error(message, error ? { cause: error } : undefined);
  playbackError.name = "AudioPlaybackError";
  return playbackError;
}
