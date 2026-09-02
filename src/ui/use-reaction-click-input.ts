import { useEffect, useRef, useState } from "react";
import { ClickPatternDetector, decibelsToMeter, microphoneErrorKind, noteMicrophoneReleased, registerMicrophoneRelease, analyzeClickWaveform, rmsToDecibels, type ClickDetection, type ClickScoreDebug } from "../lib/microphone";

export type ReactionClickInputState = "idle" | "requesting" | "calibrating" | "listening" | "denied" | "missing" | "busy" | "error" | "unsupported";

export interface ReactionClickInputMonitor {
  state: ReactionClickInputState;
  /** Current input level only. Audio samples are never retained. */
  level: number;
  /** Detection threshold on the same 0–1 scale as level. */
  threshold: number | null;
  /** In-memory score and feature diagnostics for tuning the detector. */
  scoreDebug: ClickScoreDebug | null;
}

interface UseReactionClickInputOptions {
  active: boolean;
  onDetection: (detection: ClickDetection) => void;
}

export function useReactionClickInput({ active, onDetection }: UseReactionClickInputOptions): ReactionClickInputMonitor {
  const [state, setState] = useState<ReactionClickInputState>("idle");
  const [level, setLevel] = useState(0);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [scoreDebug, setScoreDebug] = useState<ClickScoreDebug | null>(null);
  const callbackRef = useRef(onDetection);
  const stopRef = useRef<() => void>(() => {});
  callbackRef.current = onDetection;

  useEffect(() => registerMicrophoneRelease(() => stopRef.current()), []);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame: number | null = null;
    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (context && context.state !== "closed") void context.close().catch(() => {});
      context = null;
      noteMicrophoneReleased();
    };
    stopRef.current = stop;

    if (!active) {
      setState("idle");
      setLevel(0);
      setThreshold(null);
      setScoreDebug(null);
      return () => stop();
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      setState("unsupported");
      return () => stop();
    }

    const start = async () => {
      setState("requesting");
      setLevel(0);
      setThreshold(null);
      setScoreDebug(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          video: false
        });
        if (cancelled) return stop();
        context = new AudioContext();
        if (context.state === "suspended") await context.resume();
        const analyser = context.createAnalyser();
        // Tooth clicks are short transients; a 512-sample window keeps them
        // from being diluted by a long RMS window (about 11 ms at 48 kHz).
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const detector = new ClickPatternDetector();
        const startedAt = performance.now();
        const sample = (now: number) => {
          if (cancelled || !stream || !context) return;
          analyser.getFloatTimeDomainData(samples);
          const features = analyzeClickWaveform(samples);
          const detection = detector.observe(features.rms, now - startedAt, features);
          const nextThreshold = detector.thresholdRms;
          setLevel(decibelsToMeter(rmsToDecibels(features.rms)));
          setThreshold(nextThreshold === null ? null : decibelsToMeter(rmsToDecibels(nextThreshold)));
          setScoreDebug(detector.scoreDebug);
          setState(detector.isCalibrating ? "calibrating" : "listening");
          if (detection) {
            callbackRef.current(detection);
          }
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
      } catch (error) {
        if (cancelled) return;
        setState(microphoneErrorKind(error));
        stop();
      }
    };
    void start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [active]);

  return { state, level, threshold, scoreDebug };
}
