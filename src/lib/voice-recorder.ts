export interface RecordedAudio {
  blob: Blob;
  durationMs: number;
  sampleRate: number;
  channels: number;
}

function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

/** Converts a decoded buffer to mono 48 kHz, 24-bit PCM WAV. */
export function audioBufferToWav(buffer: AudioBuffer, targetRate = 48_000): Blob {
  const frameCount = Math.max(1, Math.round(buffer.duration * targetRate));
  const bytesPerSample = 3;
  const dataSize = frameCount * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 24, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);
  const source = buffer.getChannelData(0);
  for (let index = 0; index < frameCount; index += 1) {
    const sourceIndex = Math.min(source.length - 1, Math.floor(index * source.length / frameCount));
    const sample = Math.max(-1, Math.min(1, source[sourceIndex] ?? 0));
    const integer = sample < 0 ? Math.round(sample * 0x800000) : Math.round(sample * 0x7fffff);
    const offset = 44 + index * bytesPerSample;
    view.setUint8(offset, integer & 0xff);
    view.setUint8(offset + 1, (integer >> 8) & 0xff);
    view.setUint8(offset + 2, (integer >> 16) & 0xff);
  }
  return new Blob([output], { type: "audio/wav" });
}

async function convertToWav(raw: Blob): Promise<Blob> {
  const decoder = new AudioContext();
  try {
    const decoded = await decoder.decodeAudioData(await raw.arrayBuffer());
    const frameCount = Math.max(1, Math.ceil(decoded.duration * 48_000));
    const offline = new OfflineAudioContext(1, frameCount, 48_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return audioBufferToWav(await offline.startRendering());
  } finally {
    await decoder.close().catch(() => {});
  }
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private animationFrame: number | null = null;
  private startedAt = 0;
  private chunks: Blob[] = [];

  async start(deviceId: string | undefined, onLevel: (level: number) => void): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("この環境では録音に対応していません");
    await this.cancel();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
      const mimeType = recorderMimeType();
      this.recorder = mimeType ? new MediaRecorder(this.stream, { mimeType }) : new MediaRecorder(this.stream);
      this.chunks = [];
      this.recorder.ondataavailable = (event) => { if (event.data.size > 0) this.chunks.push(event.data); };
      this.startedAt = performance.now();
      // Start capture before setting up the optional level meter. Some WebView2
      // audio output configurations reject AudioContext even though capture is
      // available, and that must not make recording fail.
      this.recorder.start(250);
      try {
        let context: AudioContext;
        try {
          context = new AudioContext({ sinkId: { type: "none" } } as AudioContextOptions);
        } catch {
          context = new AudioContext();
        }
        this.context = context;
        // Do not await resume(): on Windows/WebView2 it may remain pending
        // while the output endpoint is being restored. Capture is already
        // running and must be reflected in the UI immediately.
        if (context.state === "suspended") void context.resume().catch(() => {});
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(this.stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
          this.animationFrame = requestAnimationFrame(tick);
        };
        this.animationFrame = requestAnimationFrame(tick);
      } catch {
        // The recorder remains usable without a live meter.
        onLevel(0);
      }
    } catch (error) {
      await this.releaseResources();
      this.chunks = [];
      throw error;
    }
  }

  async stop(): Promise<RecordedAudio> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("録音中ではありません");
    const raw = await new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
      recorder.onerror = () => reject(new Error("録音に失敗しました"));
      recorder.stop();
    });
    const durationMs = Math.max(1, Math.round(performance.now() - this.startedAt));
    await this.releaseResources();
    return { blob: await convertToWav(raw), durationMs, sampleRate: 48_000, channels: 1 };
  }

  async cancel(): Promise<void> {
    if (this.recorder?.state === "recording") this.recorder.stop();
    await this.releaseResources();
    this.chunks = [];
  }

  private async releaseResources(): Promise<void> {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }
}
