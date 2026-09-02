import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { callDisplay, validateProfile } from "../lib/name";
import {
  cancelNameVoice,
  getIrodoriModelState,
  IRODORI_MODEL_BYTES,
  nameVoiceErrorMessage,
  prepareNameVoice,
  previewNameVoice,
  unlockNameVoiceAudio,
  type IrodoriModelState,
  type NameVoiceProgress
} from "../lib/irodori-name-voice";
import { platform } from "../lib/platform";
import type { NameProfile } from "../types";
import { BackLink } from "./shared";
import { useWorks } from "./works-context";
import { MicrophoneTester } from "./MicrophoneTester";

type GenerationState = "INPUT" | "PREFLIGHT" | "GENERATING" | "READY" | "ERROR";
const initial: NameProfile = { displayName: "", reading: "", form: "senpai", saveCandidate: false };

export function NameScreen() {
  const { workId, version } = useParams(); const { getWork } = useWorks(); const navigate = useNavigate();
  const work = getWork(workId, version); const [profile, setProfile] = useState<NameProfile>(initial);
  const [state, setState] = useState<GenerationState>("INPUT"); const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState(""); const [modelState, setModelState] = useState<IrodoriModelState>("NOT_INSTALLED");
  const [previewing, setPreviewing] = useState(false); const runId = useRef(0);
  const errors = useMemo(() => validateProfile(profile), [profile]);
  useEffect(() => { getIrodoriModelState().then(setModelState); }, []);
  if (!work) return <div className="page"><h1>作品が見つかりません</h1></div>;

  const update = <K extends keyof NameProfile>(key: K, value: NameProfile[K]) => {
    runId.current += 1; cancelNameVoice(); setProfile((old) => ({ ...old, [key]: value })); setState("INPUT"); setProgress(0); setMessage("");
  };
  const prepare = async () => {
    if (Object.keys(errors).length) return;
    const currentRun = ++runId.current;
    setState("GENERATING"); setProgress(0.01); setMessage("Irodori名前音声の準備を始めます");
    try {
      await prepareNameVoice(work, profile, (event) => {
        if (runId.current !== currentRun) return;
        setProgress(progressValue(event));
        setMessage(progressMessage(event));
      });
      if (runId.current !== currentRun) return;
      sessionStorage.setItem(`pne.profile.${work.workId}.${work.version}`, JSON.stringify(profile));
      setModelState("READY"); setProgress(1); setMessage("Irodoriで名前音声を生成しました"); setState("READY");
    } catch (error) {
      if (runId.current !== currentRun) return;
      setState("ERROR"); setMessage(nameVoiceErrorMessage(error));
    }
  };
  const preview = async () => {
    try { setPreviewing(true); setMessage("生成した名前音声を再生しています…"); await previewNameVoice(work, profile); setMessage("試聴が終わりました"); }
    catch (error) { setState("ERROR"); setMessage(nameVoiceErrorMessage(error)); }
    finally { setPreviewing(false); }
  };

  return <div className="page name-page">
    <BackLink to={`/works/${work.workId}/${work.version}`}>作品の準備に戻る</BackLink>
    <div className="step-indicator" aria-label="準備の進行"><span className="done">1<i>作品</i></span><b /><span className="active">2<i>名前</i></span><b /><span>3<i>再生</i></span></div>
    <section className="name-layout">
      <div className="name-form-panel"><p className="eyebrow">NAME VOICE</p><h1>物語で呼ばれる名前</h1><p className="lead">入力内容はこのPC内だけで処理され、外部へ送信されません。</p>
        <label>画面に表示する名前<input value={profile.displayName} onChange={(event) => update("displayName", event.target.value)} placeholder="例：みなと" maxLength={32} aria-invalid={Boolean(errors.displayName)} />{profile.displayName && errors.displayName && <small className="field-error">{errors.displayName}</small>}</label>
        <label>読みかた <span>ひらがな／カタカナ</span><input value={profile.reading} onChange={(event) => update("reading", event.target.value)} placeholder="例：みなと" maxLength={64} aria-invalid={Boolean(errors.reading)} />{profile.reading && errors.reading && <small className="field-error">{errors.reading}</small>}</label>
        <fieldset><legend>呼ばれかた</legend><div className="form-options">{(["bare", "san", "kun", "chan", "senpai"] as const).map((form) => <button key={form} className={profile.form === form ? "active" : ""} onClick={() => update("form", form)}>{({ bare: "呼び捨て", san: "さん", kun: "くん", chan: "ちゃん", senpai: "先輩" })[form]}</button>)}</div></fieldset>
        <label className="checkbox-row"><input type="checkbox" checked={profile.saveCandidate} onChange={(event) => update("saveCandidate", event.target.checked)} /><span><b>次回の入力候補として保存する</b><small>未完了セッションと生成音声は、この設定にかかわらず削除するまでPCに残ります。</small></span></label>
        <MicrophoneTester compact />
        <div className={`model-status ${modelState === "READY" ? "ready" : ""}`}><span>{modelState === "READY" ? "✓" : "↓"}</span><div><b>Irodori名前音声モデル</b><small>{modelState === "READY" ? "アプリに同梱済み。生成音声もこのPC内に保存されます" : modelState === "PARTIAL" ? "一部取得済み。再開すると残りを取得します" : `同梱モデル（約1.3GB / ${formatBytes(IRODORI_MODEL_BYTES)}）を確認できません`}</small></div></div>
        {state === "GENERATING" && <div className="generation-progress" role="status"><div><span>{message}</span><b>{Math.round(progress * 100)}%</b></div><progress value={progress} max={1} /><button onClick={() => { runId.current += 1; cancelNameVoice(); setState("INPUT"); setMessage("キャンセルしました"); getIrodoriModelState().then(setModelState); }}>キャンセル</button></div>}
        {state === "ERROR" && <div className="inline-error" role="alert">{message}</div>}
        {state !== "READY" ? <button className="button primary large full" disabled={Object.keys(errors).length > 0 || !profile.displayName || !profile.reading || state === "GENERATING"} onClick={prepare}>Irodoriで名前音声を準備</button> : <div className="ready-actions"><button className="button secondary" disabled={previewing} onClick={preview}>{previewing ? "再生中…" : "▶ 生成音声を聴く"}</button><button className="button primary large" onClick={async () => { await unlockNameVoiceAudio(); await platform.deleteSession(work.workId, work.version); navigate(`/play/${work.workId}/${work.version}?restart=1`); }}>この名前で始める →</button></div>}
        <Link className="text-link" to={`/play/${work.workId}/${work.version}?fallback=1&restart=1`} onClick={() => platform.deleteSession(work.workId, work.version)}>名前なしで再生する</Link>
      </div>
      <aside className="name-preview-card"><div className="portrait"><img src="/girl.PNG" alt="" /><div className="sound-rings"><i /><i /><i /></div></div><p>物語の中では、こんなふうに呼ばれます</p><blockquote>「……{profile.displayName ? callDisplay(profile) : "あなた"}。聞こえる？」</blockquote><div className="privacy-card"><span>⌁</span><div><b>プライベート処理</b><small>名前・読み・生成音声はP.N.E.サーバーや第三者サービスへ送信しません。</small></div></div></aside>
    </section>
  </div>;
}

function progressValue(event: NameVoiceProgress): number {
  if (event.stage === "scanning") return 0.01;
  if (event.stage === "cache-check") return 0.03;
  if (event.stage === "loading-model") return 0.04 + event.progress * 0.76;
  if (event.stage === "generating") return 0.8 + event.progress * 0.14;
  if (event.stage === "cutting") return 0.95;
  if (event.stage === "saving") return 0.98;
  return event.stage === "ready" || event.stage === "partial" ? 1 : event.progress;
}

function progressMessage(event: NameVoiceProgress): string {
  if (event.stage === "scanning") return "必要な名前スロットを確認しています";
  if (event.stage === "cache-check") return "このPCに生成済みの音声があるか確認しています";
  if (event.stage === "loading-model") {
    const bytes = event.loadedBytes != null ? `${formatBytes(event.loadedBytes)} / ${formatBytes(event.totalBytes ?? IRODORI_MODEL_BYTES)}` : "準備中";
    const sourceLabel = event.source === "bundled" ? "同梱モデルを読込中" : event.cached ? "キャッシュから読込中" : "モデルを取得中";
    return `${sourceLabel}：${event.component ?? "runtime"}（${bytes}）`;
  }
  if (event.stage === "generating") return `Irodori WebGPUで「${event.callReading ?? "名前"}」を生成しています`;
  if (event.stage === "cutting") return "呼びかけ部分を自然な長さに整えています";
  if (event.stage === "saving") return "生成音声をこのPC内に保存しています";
  return "名前音声の準備ができました";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)}KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
}
