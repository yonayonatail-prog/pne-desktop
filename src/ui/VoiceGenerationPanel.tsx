import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthoringCharacter, AuthoringNode, AuthoringPack, VoicePreset } from "../authoring/types";
import { findVoicePreset, DEFAULT_VOICE_PRESETS } from "../authoring/voice-generation/voice-preset-catalog";
import { getDialogueVoiceGenerator } from "../lib/irodori-dialogue-voice";
import { playAudioSource } from "../lib/audio-playback";
import {
  emptyVoiceGenerationManifest,
  hydrateVoiceRound,
  loadVoiceGenerationManifest,
  persistVoiceRound,
  selectVoiceCandidate,
  voiceAudioKey
} from "../authoring/voice-generation/generation-store";
import type { DialogueGenerationProgress, VoiceCandidateAudio, VoiceRoundWithAudio } from "../authoring/voice-generation/types";
import type { VoiceGenerationManifest } from "../authoring/types";
import { PACE_OPTIONS } from "../authoring/voice-generation/duration-policy";

interface VoiceGenerationPanelProps {
  projectId: string;
  pack: AuthoringPack;
  selectedNode: AuthoringNode;
  selectedCharacter?: AuthoringCharacter;
  onAssignPreset: (presetId: string) => void;
  onApplyCandidate: (candidate: VoiceCandidateAudio, round: VoiceRoundWithAudio, manifest: VoiceGenerationManifest) => void;
}

const candidateLabels = {
  A: { label: "標準", description: "前文脈と自然な発話姿勢" },
  B: { label: "感情寄り", description: "演技ヒントと必要な次文脈" },
  C: { label: "場面寄り", description: "前後文脈と場面状態" }
} as const;

function referenceFor(pack: AuthoringPack, character: AuthoringCharacter | undefined, preset: VoicePreset | undefined): string {
  if (!preset) return "";
  const profile = pack.voice_profiles?.find((entry) => entry.voice_preset_id === preset.voice_preset_id || entry.voice_id === character?.character_id);
  return profile?.reference_audio || preset.reference_audio || "";
}

function errorMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "VOICE_REFERENCE_MISSING") return "参照音声を選択してください。";
  if (code === "VOICE_PRESET_UNAVAILABLE") return "このVoicePresetは現在のTauriランタイムでは利用できません。";
  if (code === "WEBGPU_UNAVAILABLE") return "WebGPUを利用できないため生成できません。GPUドライバーとWebView2を確認してください。";
  if (code === "MODEL_DOWNLOAD_FAILED") return "Irodoriモデルを取得できませんでした。通信環境と空き容量を確認してください。";
  if (code === "REFERENCE_LOAD_FAILED") return "参照音声を読み込めませんでした。ファイルの場所と形式を確認してください。";
  if (code === "REFERENCE_DECODE_FAILED") return "参照音声をデコードできませんでした。WAV / MP3 / OGGの別ファイルを選んでください。";
  if (code === "AUDIO_CONTEXT_UNAVAILABLE") return "このWebViewでは音声デコードを利用できません。Tauri版のWebView2を更新してください。";
  if (code === "GENERATION_OOM") return "GPUメモリが不足しました。他のGPUアプリを閉じるか、台詞を短くして再生成してください。";
  if (error instanceof DOMException && error.name === "AbortError") return "生成をキャンセルしました。";
  return error instanceof Error ? error.message : "台詞音声を生成できませんでした。";
}

export function VoiceGenerationPanel({ projectId, pack, selectedNode, selectedCharacter, onAssignPreset, onApplyCandidate }: VoiceGenerationPanelProps) {
  const defaultPreset = findVoicePreset(selectedCharacter?.voice_preset_id);
  const [presetId, setPresetId] = useState(defaultPreset?.voice_preset_id || DEFAULT_VOICE_PRESETS[0]?.voice_preset_id || "");
  const [paceMultiplier, setPaceMultiplier] = useState(1);
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceName, setReferenceName] = useState("");
  const [round, setRound] = useState<VoiceRoundWithAudio | null>(null);
  const [manifest, setManifest] = useState(() => emptyVoiceGenerationManifest(projectId));
  const [progress, setProgress] = useState<DialogueGenerationProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  const preset = useMemo(() => findVoicePreset(presetId), [presetId]);
  const resolvedReference = referenceUrl || referenceFor(pack, selectedCharacter, preset);
  const unitId = `unit_${selectedNode.id}`;

  useEffect(() => {
    const nextPreset = findVoicePreset(selectedCharacter?.voice_preset_id);
    const nextId = nextPreset?.voice_preset_id || DEFAULT_VOICE_PRESETS[0]?.voice_preset_id || "";
    setPresetId(nextId);
    setReferenceUrl("");
    setReferenceName("");
    setError("");
  }, [selectedCharacter?.character_id, selectedCharacter?.voice_preset_id, selectedNode.id]);

  useEffect(() => {
    let active = true;
    const nextManifest = loadVoiceGenerationManifest(projectId);
    setManifest(nextManifest);
    const unit = nextManifest.units.find((entry) => entry.generation_unit_id === unitId);
    const latest = unit?.rounds.at(-1);
    if (!latest) { setRound(null); return () => { active = false; }; }
    hydrateVoiceRound(latest).then((hydrated) => { if (active) setRound(hydrated); }).catch(() => { if (active) setRound(null); });
    return () => { active = false; };
  }, [projectId, unitId]);

  useEffect(() => () => {
    controllerRef.current?.abort();
    if (referenceUrl.startsWith("blob:")) URL.revokeObjectURL(referenceUrl);
  }, [referenceUrl]);

  const choosePreset = (nextId: string) => {
    if (referenceUrl.startsWith("blob:")) URL.revokeObjectURL(referenceUrl);
    setPresetId(nextId);
    setReferenceUrl("");
    setReferenceName("");
    onAssignPreset(nextId);
    setRound(null);
    setError("");
  };

  const chooseReference = (file: File | undefined) => {
    if (!file) return;
    if (referenceUrl.startsWith("blob:")) URL.revokeObjectURL(referenceUrl);
    setReferenceUrl(URL.createObjectURL(file));
    setReferenceName(file.name);
    setError("");
  };

  const generate = async () => {
    if (!preset || preset.mode !== "reference") {
      setError("参照音声モードのVoicePresetを選択してください。");
      return;
    }
    if (!resolvedReference) {
      setError("参照音声を選択してください。");
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true); setError(""); setProgress({ stage: "preparing", progress: 0, message: "生成を準備しています" });
    try {
      const generated = await getDialogueVoiceGenerator().generateRound({
        nodes: pack.nodes,
        nodeId: selectedNode.id,
        preset,
        referenceUrl: resolvedReference,
        firstPerson: selectedCharacter?.first_person,
        paceMultiplier,
        signal: controller.signal,
        onProgress: setProgress
      });
      const nextManifest = await persistVoiceRound(projectId, generated, manifest);
      const persistedRound: VoiceRoundWithAudio = {
        ...generated,
        candidates: generated.candidates.map((candidate) => ({
          ...candidate,
          raw_audio_key: candidate.raw_audio ? voiceAudioKey(projectId, candidate.candidate_id, "raw") : candidate.raw_audio_key,
          trimmed_audio_key: candidate.trimmed_audio ? voiceAudioKey(projectId, candidate.candidate_id, "trimmed") : candidate.trimmed_audio_key
        })) as [VoiceCandidateAudio, VoiceCandidateAudio, VoiceCandidateAudio]
      };
      setManifest(nextManifest);
      setRound(persistedRound);
    } catch (generationError) {
      setError(errorMessage(generationError));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
  };

  const cancel = () => controllerRef.current?.abort();

  const selectCandidate = (candidate: VoiceCandidateAudio) => {
    if (!round) return;
    try {
      const nextManifest = selectVoiceCandidate(manifest, round.generation_unit_id, round.round_id, candidate.candidate_id);
      setManifest(nextManifest);
      onApplyCandidate(candidate, round, nextManifest);
    } catch (selectionError) {
      setError(errorMessage(selectionError));
    }
  };

  const selectRound = async (roundId: string) => {
    const record = manifest.units.find((unit) => unit.generation_unit_id === unitId)?.rounds.find((entry) => entry.round_id === roundId);
    if (!record) return;
    try { setRound(await hydrateVoiceRound(record)); setError(""); }
    catch (selectionError) { setError(errorMessage(selectionError)); }
  };

  const playCandidate = async (candidate: VoiceCandidateAudio) => {
    const audio = candidate.trimmed_audio || candidate.raw_audio;
    if (!audio) { setError("試聴用のTrim済み音声がありません。"); return; }
    try { await playAudioSource(audio); } catch (playbackError) { setError(errorMessage(playbackError)); }
  };

  return <section className="voice-generation-panel">
    <div className="authoring-section-head">
      <div><p className="eyebrow">IRODORI VOICE LAB</p><h2>文脈付き台詞音声</h2></div>
      <span className="voice-fixed-badge">NUM_STEPS 34 固定</span>
    </div>
    <p className="voice-generation-intro">参照音声を固定したまま、文脈違いのA/B/Cを生成します。3つとも合わない場合は同じ条件でシードを変えて再生成できます。</p>

    <div className="voice-preset-section">
      <div className="authoring-section-head"><h3>VoicePreset</h3><span>サンプルから選択</span></div>
      <div className="voice-preset-rail" role="listbox" aria-label="音声プリセット">
        {DEFAULT_VOICE_PRESETS.map((candidate) => <button type="button" role="option" aria-selected={candidate.voice_preset_id === presetId} key={candidate.voice_preset_id} className={`voice-preset-card ${candidate.voice_preset_id === presetId ? "active" : ""}`} onClick={() => choosePreset(candidate.voice_preset_id)}>
          <span className="voice-preset-group">{candidate.group}</span><b>{candidate.label}</b><small>{candidate.tags.join(" · ")}</small>
          {candidate.preview_audio && <span className="voice-preset-preview" onClick={(event) => { event.stopPropagation(); void playAudioSource(candidate.preview_audio!).catch((playbackError) => setError(errorMessage(playbackError))); }}>▶ サンプル</span>}
        </button>)}
        <label className={`voice-preset-card custom ${referenceName ? "active" : ""}`}>
          <span className="voice-preset-group">CUSTOM</span><b>参照音声を選ぶ</b><small>{referenceName || "WAV / MP3 / OGG"}</small>
          <input type="file" accept="audio/wav,audio/x-wav,audio/mpeg,audio/ogg,audio/*" hidden onChange={(event) => { chooseReference(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
      </div>
      <div className="voice-reference-row"><span>参照音声</span><code>{referenceName || (resolvedReference ? preset?.reference_audio || "登録済みサンプル" : "未選択")}</code>{referenceName && <button type="button" className="button compact secondary" onClick={() => { if (referenceUrl.startsWith("blob:")) URL.revokeObjectURL(referenceUrl); setReferenceUrl(""); setReferenceName(""); }}>プリセットへ戻す</button>}</div>
    </div>

    <div className="voice-generation-controls">
      <label>読み速度<select value={String(paceMultiplier)} disabled={busy} onChange={(event) => setPaceMultiplier(Number(event.target.value))}>{PACE_OPTIONS.map((option) => <option key={option.id} value={option.multiplier}>{option.label}</option>)}</select></label>
      <div className="voice-fixed-control"><span>品質設定</span><b>num_steps = 34</b><small>ユーザー変更不可</small></div>
      <div className="voice-generation-actions"><button type="button" className="button primary" onClick={() => void generate()} disabled={busy || !selectedCharacter || !selectedNode.text.trim()}>{busy ? "生成中…" : round ? "A/B/Cを再生成" : "A/B/Cを生成"}</button>{busy && <button type="button" className="button secondary" onClick={cancel}>キャンセル</button>}</div>
    </div>
    {progress && busy && <div className="voice-progress" role="status"><div><span>{progress.message || "処理中…"}</span><b>{Math.round(progress.progress * 100)}%</b></div><progress value={progress.progress} max={1} /></div>}
    {preset?.mode === "voice_design" && <p className="voice-warning">このプリセットはVoiceDesignモードです。現在の直接WebGPU生成では参照音声モードのみ対応しています。</p>}
    {error && <p className="voice-error" role="alert">{error}</p>}

    {round && <div className="voice-candidate-section">
      <div className="authoring-section-head"><h3>生成候補 <span className="voice-round-label">{round.round_id}</span></h3><div className="voice-round-tools"><span>{round.seconds}s · {round.spoken_text.length}文字</span>{(manifest.units.find((unit) => unit.generation_unit_id === unitId)?.rounds.length || 0) > 1 && <label>履歴<select value={round.round_id} disabled={busy} onChange={(event) => void selectRound(event.target.value)}>{manifest.units.find((unit) => unit.generation_unit_id === unitId)?.rounds.slice().reverse().map((entry) => <option key={entry.round_id} value={entry.round_id}>{entry.round_id} · {entry.status}</option>)}</select></label>}</div></div>
      <div className="voice-candidate-grid">
        {round.candidates.map((candidate) => { const meta = candidateLabels[candidate.variant]; const selected = manifest.units.find((unit) => unit.generation_unit_id === round.generation_unit_id)?.selected_candidate_id === candidate.candidate_id; return <article className={`voice-candidate-card ${selected ? "selected" : ""} ${candidate.status === "failed" ? "failed" : ""}`} key={candidate.candidate_id}>
          <div className="voice-candidate-head"><div><span className="voice-variant-mark">{candidate.variant}</span><b>{meta.label}</b></div>{selected && <span className="voice-selected-mark">採用中</span>}</div>
          <p>{meta.description}</p>
          <div className="voice-candidate-meta"><span>{candidate.duration_ms ? `${(candidate.duration_ms / 1000).toFixed(1)}s` : "生成失敗"}</span><span>{candidate.trim_status || candidate.error_code || "—"}</span></div>
          {candidate.error_detail && <small className="voice-candidate-error-detail" title={candidate.error_detail}>{candidate.error_detail}</small>}
          {candidate.warnings.length > 0 && <small className="voice-candidate-warning">△ {candidate.warnings.join(" / ")}</small>}
          <div className="voice-candidate-actions"><button type="button" className="button secondary" onClick={() => void playCandidate(candidate)} disabled={candidate.status === "failed"}>▶ 試聴</button><button type="button" className="button primary" onClick={() => selectCandidate(candidate)} disabled={candidate.status === "failed"}>この候補を採用</button></div>
        </article>; })}
      </div>
      <p className="voice-candidate-footnote">Trim警告は自動的な不採用判定ではありません。音声を試聴して採用を決めてください。</p>
    </div>}
  </section>;
}
