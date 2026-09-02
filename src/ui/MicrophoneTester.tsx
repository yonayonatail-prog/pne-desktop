import { useCallback, useEffect, useRef, useState } from "react";
import { analyzeClickWaveform, ClickPatternDetector, decibelsToMeter, microphoneErrorKind, noteMicrophoneReleased, registerMicrophoneRelease, rmsToDecibels } from "../lib/microphone";

type TesterState = "idle" | "requesting" | "waiting" | "receiving" | "silent" | "denied" | "missing" | "busy" | "disconnected" | "unsupported" | "error";
type ClickTestState = "idle" | "calibrating" | "listening" | "detected";
interface MicrophoneDevice { deviceId: string; label: string; }

const stateCopy: Record<TesterState, { title: string; detail: string }> = {
  idle: { title: "マイクは未確認です", detail: "テストを開始すると、接続状態と入力レベルを確認します。" },
  requesting: { title: "マイクを確認しています", detail: "表示された場合は、マイクの使用を許可してください。" },
  waiting: { title: "マイク接続済み・入力待ち", detail: "マイクに向かって話すか、軽く音を入れてください。" },
  receiving: { title: "音声を受信しています", detail: "プログラムまでマイク音声が届いています。" },
  silent: { title: "接続済み・音声入力なし", detail: "マイクは認識されていますが、音が届いていません。ミュートや入力音量を確認してください。" },
  denied: { title: "マイクを使用できません", detail: "マイク権限が拒否されています。OSまたはアプリの権限設定を確認してください。" },
  missing: { title: "入力マイクが見つかりません", detail: "マイクを接続してから、もう一度確認してください。" },
  busy: { title: "マイクを開始できません", detail: "ほかのアプリがマイクを使用中か、OSで無効になっている可能性があります。" },
  disconnected: { title: "マイクが切断されました", detail: "マイクを接続し直して、再チェックしてください。" },
  unsupported: { title: "マイク診断に非対応です", detail: "この実行環境ではマイク入力APIを利用できません。" },
  error: { title: "マイクの確認に失敗しました", detail: "接続と権限を確認して、再チェックしてください。" }
};

const clickStateCopy: Record<ClickTestState, { title: string; detail: string }> = {
  idle: { title: "歯カチ入力は未確認です", detail: "テストを開始すると、歯を鳴らす短い音も確認できます。" },
  calibrating: { title: "周囲の音を確認中", detail: "約2秒だけ静かにして、そのままお待ちください。" },
  listening: { title: "歯カチ入力を待っています", detail: "口を少し開き、歯を1回だけカチッと鳴らしてください。" },
  detected: { title: "歯カチ入力を検出しました", detail: "入力できています。もう一度鳴らして繰り返し確認できます。" }
};

export function MicrophoneTester({ compact = false }: { compact?: boolean }) {
  const [testerState, setTesterState] = useState<TesterState>("idle");
  const [level, setLevel] = useState(0);
  const [decibels, setDecibels] = useState(-60);
  const [devices, setDevices] = useState<MicrophoneDevice[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [clickTestState, setClickTestState] = useState<ClickTestState>("idle");
  const [clickAnimation, setClickAnimation] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const clickResetRef = useRef<number | null>(null);
  const runRef = useRef(0);

  const stop = useCallback(async () => {
    const hadActiveResources = streamRef.current !== null || contextRef.current !== null;
    runRef.current += 1;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    if (clickResetRef.current !== null) window.clearTimeout(clickResetRef.current);
    clickResetRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (hadActiveResources) noteMicrophoneReleased();
    if (context && context.state !== "closed") await context.close().catch(() => {});
  }, []);

  const stopAndReset = useCallback(async () => {
    await stop();
    setTesterState("idle");
    setLevel(0);
    setDecibels(-60);
    setClickTestState("idle");
  }, [stop]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    setDevices(inputs.map((device, index) => ({ deviceId: device.deviceId, label: device.label || `マイク ${index + 1}` })));
  }, []);

  const start = useCallback(async (requestedDeviceId = deviceId) => {
    await stop();
    const run = runRef.current;
    setLevel(0);
    setDecibels(-60);
    setClickTestState("idle");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      setTesterState("unsupported");
      return;
    }
    setTesterState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: requestedDeviceId ? { deviceId: { exact: requestedDeviceId } } : true, video: false });
      if (runRef.current !== run) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) throw new DOMException("No audio track", "NotFoundError");
      streamRef.current = stream;
      const selectedId = track.getSettings().deviceId || requestedDeviceId;
      if (selectedId) setDeviceId(selectedId);
      await refreshDevices();

      let context: AudioContext;
      try {
        context = new AudioContext({ sinkId: { type: "none" } } as AudioContextOptions);
      } catch {
        context = new AudioContext();
      }
      contextRef.current = context;
      if (context.state === "suspended") await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const clickDetector = new ClickPatternDetector();
      const startedAt = performance.now();
      let lastSignalAt = 0;

      const disconnected = () => {
        if (runRef.current === run) {
          setTesterState("disconnected");
          setLevel(0);
          setDecibels(-60);
          setClickTestState("idle");
        }
      };
      track.addEventListener("ended", disconnected, { once: true });
      track.addEventListener("mute", disconnected, { once: true });
      setTesterState("waiting");
      setClickTestState("calibrating");

      const sample = (now: number) => {
        if (runRef.current !== run || track.readyState === "ended") return;
        if (track.muted) {
          setTesterState("disconnected");
          setLevel(0);
          setDecibels(-60);
          setClickTestState("idle");
          animationRef.current = requestAnimationFrame(sample);
          return;
        }
        analyser.getFloatTimeDomainData(samples);
        const features = analyzeClickWaveform(samples);
        const db = rmsToDecibels(features.rms);
        const meter = decibelsToMeter(db);
        setDecibels(db);
        setLevel(meter);
        const click = clickDetector.observe(features.rms, now - startedAt, features);
        if (!clickDetector.isCalibrating) {
          setClickTestState((current) => current === "detected" ? current : "listening");
        }
        if (click) {
          setClickTestState("detected");
          setClickAnimation((value) => value + 1);
          if (clickResetRef.current !== null) window.clearTimeout(clickResetRef.current);
          clickResetRef.current = window.setTimeout(() => {
            if (runRef.current === run) setClickTestState("listening");
          }, 1100);
        }
        if (db > -48) {
          lastSignalAt = now;
          setTesterState("receiving");
        } else if (lastSignalAt && now - lastSignalAt < 900) {
          setTesterState("receiving");
        } else if (now - startedAt >= 3000) {
          setTesterState("silent");
        } else {
          setTesterState("waiting");
        }
        animationRef.current = requestAnimationFrame(sample);
      };
      animationRef.current = requestAnimationFrame(sample);
    } catch (error) {
      if (runRef.current !== run) return;
      const errorState = microphoneErrorKind(error);
      await stop();
      setTesterState(errorState);
      setLevel(0);
      setDecibels(-60);
      setClickTestState("idle");
    }
  }, [deviceId, refreshDevices, stop]);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    const onDeviceChange = () => {
      void refreshDevices();
      const track = streamRef.current?.getAudioTracks()[0];
      if (track?.readyState === "ended") setTesterState("disconnected");
    };
    void refreshDevices().catch(() => { /* device labels remain hidden until permission is granted */ });
    navigator.mediaDevices.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
      void stop();
    };
  }, [refreshDevices, stop]);

  useEffect(() => registerMicrophoneRelease(stopAndReset), [stopAndReset]);

  const active = ["waiting", "receiving", "silent"].includes(testerState);
  const statusTone = testerState === "receiving" ? "ok" : ["waiting", "silent", "idle", "requesting"].includes(testerState) ? "warn" : "error";
  const copy = stateCopy[testerState];
  const clickCopy = clickStateCopy[clickTestState];

  return <section className={`mic-tester ${compact ? "compact" : ""}`} aria-label="マイクテスター">
    <div className="mic-tester-head">
      <div><p className="eyebrow">MIC TEST</p><h2>マイクテスター</h2></div>
      <span className={`mic-status ${statusTone}`}><i />{copy.title}</span>
    </div>
    <p className="mic-detail">{copy.detail}</p>
    <div className="mic-meter-row">
      <span aria-hidden className="mic-glyph">♩</span>
      <div className="mic-meter" role="meter" aria-label="マイク入力レベル" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{ width: `${Math.max(1.5, level * 100)}%` }} /></div>
      <output>{active ? `${Math.round(decibels)} dB` : "-- dB"}</output>
    </div>
    <div className={`tooth-click-test ${clickTestState}`}>
      <div className="tooth-click-visual" aria-hidden="true">
        <span key={clickAnimation} className={`tooth-click-sprite ${clickTestState === "detected" ? "is-detected" : ""}`} />
      </div>
      <div className="tooth-click-copy">
        <p className="eyebrow">TOOTH CLICK</p>
        <b>{clickCopy.title}</b>
        <small>{clickCopy.detail}</small>
      </div>
      <span className="tooth-click-result" role="status" aria-live="polite">{clickTestState === "detected" ? "検出 ✓" : clickTestState === "calibrating" ? "校正中" : clickTestState === "listening" ? "待受中" : "未確認"}</span>
    </div>
    <div className="mic-tester-controls">
      {devices.length > 0 && <label>入力デバイス<select value={deviceId} onChange={(event) => { const next = event.target.value; setDeviceId(next); if (active) void start(next); }}>{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}</select></label>}
      {active && <button className="button secondary" onClick={() => void stopAndReset()}>テストを停止</button>}
      <button className="button secondary" disabled={testerState === "requesting"} onClick={() => void start()}>{active ? "再チェック" : testerState === "requesting" ? "確認中…" : "テストを開始"}</button>
    </div>
    <small className="mic-privacy">音声はレベル表示と歯カチ判定だけに使用し、録音・文字起こし・保存・送信はしません。</small>
  </section>;
}
