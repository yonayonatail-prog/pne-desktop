import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { AfurecoProject, ScriptLine, Take } from "../afureco/types";
import { getAfurecoProject } from "../lib/afureco-project-storage";
import { listTakes, loadTakeAudio, saveTake } from "../lib/afureco-storage";
import { microphoneErrorKind } from "../lib/microphone";
import { VoiceRecorder, type RecordedAudio } from "../lib/voice-recorder";
import { BackLink, EmptyState, PageHeader } from "./shared";

const statusLabel: Record<ScriptLine["status"], string> = {
  NOT_RECORDED: "未収録", IN_PROGRESS: "収録中", SUBMITTED: "提出待ち", REVISION_REQUESTED: "修正依頼", APPROVED: "承認済み"
};

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function AfurecoProjectScreen() {
  const { projectId } = useParams();
  const [project, setProject] = useState<AfurecoProject>();
  const [projectLoading, setProjectLoading] = useState(true);
  const [lines, setLines] = useState<ScriptLine[]>([]);
  const [takes, setTakes] = useState<Take[]>([]);
  const [selectedLineId, setSelectedLineId] = useState(project?.lines[0]?.lineId ?? "");
  const [selectedAudioUrl, setSelectedAudioUrl] = useState<string | null>(null);
  const [pendingRecording, setPendingRecording] = useState<RecordedAudio | null>(null);
  const [memo, setMemo] = useState("");
  const [recording, setRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const recordingStateRef = useRef(false);
  const recorderRef = useRef(new VoiceRecorder());

  useEffect(() => {
    let active = true;
    setProjectLoading(true);
    void getAfurecoProject(projectId).then((nextProject) => {
      if (!active) return;
      setProject(nextProject);
      setLines(nextProject?.lines ?? []);
      setSelectedLineId(nextProject?.lines[0]?.lineId ?? "");
      setProjectLoading(false);
    }).catch(() => {
      if (active) {
        setProject(undefined);
        setLines([]);
        setProjectLoading(false);
        setError("アフレコ案件を読み込めませんでした。");
      }
    });
    return () => { active = false; };
  }, [projectId]);

  const refreshTakes = useCallback(async () => {
    if (!project) return;
    const nextTakes = await listTakes(project.projectId);
    setTakes(nextTakes);
    setLines(project.lines.map((line) => {
      const lineTakes = nextTakes.filter((take) => take.lineId === line.lineId);
      return lineTakes.length ? { ...line, status: lineTakes.some((take) => take.reviewStatus === "APPROVED") ? "APPROVED" : "SUBMITTED" } : line;
    }));
  }, [project]);

  useEffect(() => { void refreshTakes().catch(() => setError("保存済みテイクを読み込めませんでした。")); }, [refreshTakes]);
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices.enumerateDevices().then((devices) => setDeviceId(devices.find((device) => device.kind === "audioinput")?.deviceId ?? "")).catch(() => {});
  }, []);
  useEffect(() => { recordingStateRef.current = recording; }, [recording]);
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (recordingStateRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => { window.removeEventListener("beforeunload", onBeforeUnload); void recorderRef.current.cancel(); };
  }, []);
  useEffect(() => {
    let active = true;
    const latest = [...takes].filter((take) => take.lineId === selectedLineId).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    if (!latest) { setSelectedAudioUrl(null); return () => { active = false; }; }
    void loadTakeAudio(latest.fileId).then((blob) => {
      if (!active || !blob) return;
      const url = URL.createObjectURL(blob);
      setSelectedAudioUrl(url);
    }).catch(() => {});
    return () => { active = false; setSelectedAudioUrl((url) => { if (url) URL.revokeObjectURL(url); return null; }); };
  }, [selectedLineId, takes]);

  const selectedLine = useMemo(() => lines.find((line) => line.lineId === selectedLineId) ?? lines[0], [lines, selectedLineId]);
  const selectedTakes = useMemo(() => takes.filter((take) => take.lineId === selectedLine?.lineId), [takes, selectedLine]);
  const recordedCount = lines.filter((line) => line.status !== "NOT_RECORDED").length;
  const allLinesSubmitted = lines.length > 0 && lines.every((line) => line.status === "SUBMITTED" || line.status === "APPROVED");
  const localStoragePath = `このPC / P.N.E.アプリ内データ / アフレコ / ${project?.projectName ?? "収録案件"}`;

  if (projectLoading) return <div className="page"><EmptyState title="案件を読み込んでいます">少しお待ちください。</EmptyState></div>;
  if (!project || !selectedLine) return <div className="page"><EmptyState title="案件が見つかりません">このアフレコ案件は存在しないか、まだ同期されていません。</EmptyState></div>;

  const startRecording = async () => {
    setError(""); setPendingRecording(null); setLevel(0);
    try {
      await recorderRef.current.start(deviceId || undefined, setLevel);
      setRecording(true);
    } catch (cause) {
      const kind = microphoneErrorKind(cause);
      const detail = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
      setError(kind === "denied" ? "マイク権限が拒否されています。OSのプライバシー設定を確認してください。" : kind === "missing" ? "入力マイクが見つかりません。" : kind === "error" && !navigator.mediaDevices?.getUserMedia ? "このTauri/WebView環境ではマイクAPIを利用できません。" : `録音を開始できませんでした。マイクを確認してください。${detail}`);
    }
  };

  const stopRecording = async () => {
    try {
      const result = await recorderRef.current.stop();
      setPendingRecording(result); setRecording(false); setLevel(0); setError("");
    } catch (cause) {
      setRecording(false); setLevel(0); setError(cause instanceof Error ? cause.message : "録音を確定できませんでした。");
    }
  };

  const savePendingTake = async () => {
    if (!pendingRecording) return;
    const take: Take = {
      takeId: createId("take"), projectId: project.projectId, lineId: selectedLine.lineId, actorId: "local-actor",
      fileId: createId("audio"), recordedAt: new Date().toISOString(), durationMs: pendingRecording.durationMs,
      sampleRate: pendingRecording.sampleRate, channels: pendingRecording.channels, syncStatus: "LOCAL_ONLY",
      reviewStatus: "SUBMITTED", memo: memo.trim() || undefined, isSelected: false
    };
    try {
      await saveTake(take, pendingRecording.blob);
      setPendingRecording(null); setMemo(""); await refreshTakes();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "テイクを保存できませんでした。"); }
  };

  return <div className="page afureco-project-page">
    <BackLink to="/afureco">アフレコ案件一覧へ戻る</BackLink>
    <PageHeader eyebrow="RECORDING PROJECT" title={project.projectName}><span className="afureco-sync-badge"><i />LOCAL_ONLY</span></PageHeader>
    {allLinesSubmitted && !pendingRecording && <section className="afureco-complete-banner" role="status"><div className="afureco-complete-icon">✓</div><div><p className="eyebrow">RECORDING COMPLETE</p><h2>すべてのセリフパックの収録が終わりました！</h2><p>全{lines.length}セリフが提出待ちとして保存されています。</p><div className="afureco-save-location"><span>保存先</span><code>{localStoragePath}</code></div><small>現在はサーバー未同期です。保存データはこのPCのP.N.E.アプリ内にあります。</small></div></section>}
    <section className="afureco-project-head"><div><h2>{project.workTitle}</h2><p>台本 {project.scriptVersion}　·　担当キャラクター {project.assignedCharacter}</p>{project.sourceFileName && <small className="afureco-project-source">読込元：{project.sourceFileName}</small>}</div><div className="afureco-progress"><strong>{recordedCount} / {lines.length}</strong><span>収録済み</span><i><b style={{ width: `${(recordedCount / lines.length) * 100}%` }} /></i></div></section>
    <div className="afureco-layout">
      <section className="afureco-lines" aria-label="セリフ一覧"><div className="afureco-section-title"><h2>担当セリフ</h2><span>{lines.length} lines</span></div>{lines.map((line, index) => <button className={`afureco-line-row ${line.lineId === selectedLine.lineId ? "active" : ""}`} key={line.lineId} onClick={() => { if (!recording) setSelectedLineId(line.lineId); }} disabled={recording}><span className="line-index">{String(index + 1).padStart(2, "0")}</span><span className="line-copy"><b>{line.speakerName}</b><span>{line.text}</span></span><em className={`line-status ${line.status.toLowerCase()}`}>{statusLabel[line.status]}</em></button>)}</section>
      <section className="afureco-record-panel" aria-label="セリフ収録">
        <p className="eyebrow">LINE {selectedLine.nodeId}</p><h2>{selectedLine.speakerName}</h2><p className="record-line-text">{selectedLine.text}</p><p className="record-direction">演技指示　{selectedLine.direction}</p>
        <div className="record-device"><label>入力デバイス<select value={deviceId} onChange={(event) => setDeviceId(event.target.value)} disabled={recording}><option value="">既定のマイク</option>{deviceId && <option value={deviceId}>選択中のマイク</option>}</select></label><span>推奨 48kHz / 24bit・モノラルWAV</span></div>
        <div className={`record-meter ${recording ? "active" : ""}`}><i style={{ width: `${Math.max(2, level * 100)}%` }} /><span>{recording ? `${Math.round(level * 100)}%` : "待機中"}</span></div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {pendingRecording ? <div className="pending-take"><div><b>録音を停止しました</b><span>{(pendingRecording.durationMs / 1000).toFixed(1)}秒・WAVへ変換済み</span></div><div className="record-actions"><button className="button secondary" onClick={() => setPendingRecording(null)}>録り直す</button><button className="button primary" onClick={() => void savePendingTake()}>提出待ちに保存</button></div><label className="memo-field">テイクメモ<input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="例：語尾を柔らかめに" /></label></div> : recording ? <button className="button record-stop" onClick={() => void stopRecording()}><i />録音を停止</button> : <button className="button primary large full" onClick={() => void startRecording()}>● 録音を開始</button>}
        {selectedAudioUrl && <div className="latest-take"><div><b>最新テイク</b><span>{selectedTakes.length}テイク・ローカル保存</span></div><audio controls preload="metadata" src={selectedAudioUrl} /></div>}
        <p className="record-note">録音データはこのPCのブラウザ保存領域に保存されます。サーバー未接続のため、提出状態は <code>LOCAL_ONLY</code> です。</p>
      </section>
    </div>
  </div>;
}
