import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { PlayerEngine, type ReactionInput, type ResolvedHistoryEntry, type RuntimeSnapshot, type Scenario } from "@pne/player-core";
import { callDisplay } from "../lib/name";
import { playPreparedNameVoice } from "../lib/irodori-name-voice";
import { playAudioSource, stopAudioPlayback } from "../lib/audio-playback";
import { loadVoiceAudio } from "../authoring/voice-generation/generation-store";
import { platform } from "../lib/platform";
import type { NameProfile, StoredSession } from "../types";
import { useWorks } from "./works-context";
import { useReactionClickInput } from "./use-reaction-click-input";

export function PlayerScreen() {
  const { workId, version } = useParams(); const [params] = useSearchParams(); const { getWork } = useWorks(); const work = getWork(workId, version);
  const fallback = params.get("fallback") === "1";
  const wantsResume = params.get("resume") === "1";
  const publicSpaceMode = localStorage.getItem("pne.publicSpaceMode") === "1";
  const detailedReactionInput = localStorage.getItem("pne.detailedReactionInput") !== "0";
  const clickInputEnabled = localStorage.getItem("pne.clickInput") === "1";
  const [restored, setRestored] = useState<StoredSession | null | undefined>(wantsResume ? undefined : null);
  useEffect(() => { if (wantsResume && work) platform.loadSession(work.workId, work.version).then(setRestored); }, [wantsResume, work]);
  const profile = useMemo<NameProfile | null>(() => {
    if (restored?.profile) return restored.profile;
    if (fallback || !work) return null;
    const raw = sessionStorage.getItem(`pne.profile.${work.workId}.${work.version}`);
    return raw ? JSON.parse(raw) as NameProfile : null;
  }, [fallback, work, restored]);
  const engine = useMemo(() => work && restored !== undefined ? new PlayerEngine(work.scenario, work.nameSlots, {
    displayName: (slotId) => {
      const slot = work.nameSlots.find((candidate) => candidate.slot_id === slotId);
      const form = slot?.form && slot.form !== "profile" ? slot.form : profile?.form;
      return profile ? callDisplay(profile, form) : slot?.fallback_text ?? "あなた";
    },
    resolveNameAudio: (slotId) => profile ? [{ clip_id: `pne-name:${slotId}` }] : [{ clip_id: work.nameSlots.find((slot) => slot.slot_id === slotId)?.fallback_clip_id ?? "fallback" }]
  }, { visits: 0 }, restored?.snapshot, {
    inputMode: publicSpaceMode ? "PUBLIC_SPACE" : "NORMAL",
    detailedInputEnabled: detailedReactionInput,
    minimumConfidence: 0.7,
    capabilities: { airMicrophone: clickInputEnabled }
  }) : null, [work, profile, restored, publicSpaceMode, detailedReactionInput, clickInputEnabled]);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(engine?.state ?? null);
  const [entry, setEntry] = useState<ResolvedHistoryEntry | null>(null); const [muted, setMuted] = useState(false);
  const [liveEntry, setLiveEntry] = useState<ResolvedHistoryEntry | null>(null);
  const [audioError, setAudioError] = useState(""); const [audioRetry, setAudioRetry] = useState(0);
  const [reactionSeconds, setReactionSeconds] = useState(0);
  const [lastClickDetection, setLastClickDetection] = useState<"CLICK_SINGLE" | null>(null);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const sync = useCallback((next?: ResolvedHistoryEntry | null) => {
    if (!engine || !work) return;
    const state = engine.state;
    if (next !== undefined) {
      setEntry(next);
      if (next && state.mode === "LIVE") setLiveEntry(next);
    }
    setSnapshot(state);
    platform.saveSession({ workId: work.workId, workVersion: work.version, profile, snapshot: state, updatedAt: new Date().toISOString() }).catch(() => {});
  }, [engine, work, profile]);
  const completeAudio = useCallback(() => { if (!engine) return; sync(engine.audioCompleted()); }, [engine, sync]);
  useEffect(() => { if (engine) sync(engine.start()); }, [engine, sync]);
  useEffect(() => {
    if (!snapshot || snapshot.status !== "PLAYING" || !entry || !work) return;
    let cancelled = false;
    const delay = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
    const playClip = async (source: string | Blob) => { if (!cancelled) await playAudioSource(source); };
    const playSequence = async () => {
      if (muted) {
        await delay(Math.max(900, entry.audioSequence.length * 500));
      } else {
        for (const part of entry.audioSequence) {
          if (cancelled) return;
          if ("gap_ms" in part) await delay(part.gap_ms);
          else if ("clip_id" in part && part.clip_id.startsWith("pne-name:") && profile) {
            const slotId = part.clip_id.slice("pne-name:".length);
            const played = await playPreparedNameVoice(work, profile, slotId).catch(() => false);
            if (!played && !cancelled) {
              const fallback = work.nameSlots.find((slot) => slot.slot_id === slotId)?.fallback_clip_id;
              if (fallback?.startsWith("/")) await playClip(fallback);
            }
          }
          else if ("clip_id" in part && part.clip_id.startsWith("pne-generated:")) {
            const clip = await loadVoiceAudio(part.clip_id.slice("pne-generated:".length));
            if (!clip) throw new Error("採用済みの生成音声が見つかりません。台本プロジェクトと音声データが同じ端末にあるか確認してください。");
            await playClip(clip);
          }
          else if ("clip_id" in part && part.clip_id.startsWith("/")) await playClip(part.clip_id);
        }
      }
      if (!cancelled) { setAudioError(""); completeAudio(); }
    };
    playSequence().catch((error) => {
      console.error("[PlayerAudio] sequence failed", error);
      if (!cancelled) setAudioError(error instanceof Error ? error.message : "音声を再生できませんでした。");
    });
    return () => {
      cancelled = true;
      stopAudioPlayback();
    };
  }, [entry, snapshot?.status, completeAudio, muted, profile, work, audioRetry]);
  useEffect(() => {
    if (!engine || snapshot?.status !== "WAITING_REACTION") { setReactionSeconds(0); return; }
    const node = engine.node; if (node.type !== "reaction_prompt") return;
    const started = Date.now(); const deadline = started + node.reaction_window.window_ms;
    const tick = () => setReactionSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick(); const interval = window.setInterval(tick, 200); const timer = window.setTimeout(() => sync(engine.reactionTimedOut()), node.reaction_window.window_ms);
    return () => { clearInterval(interval); clearTimeout(timer); };
  }, [snapshot?.status, engine, sync]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input, textarea, select")) return;
      if (event.code === "Space") { event.preventDefault(); snapshot?.status === "PAUSED" ? sync(engine?.resume()) : (engine?.pause(), sync()); }
      if (event.key === "Escape") {
        if (backlogOpen) { setBacklogOpen(false); return; }
        engine?.pause(); sync();
      }
      if (snapshot?.status === "WAITING_REACTION") {
        const map: Record<string, ReactionInput> = publicSpaceMode
          ? { "1": "CLICK_SINGLE", "2": "SILENT", "3": "NEXT" }
          : { "1": "VOICE_YES", "2": "VOICE_NO", "3": "CLICK_SINGLE", "4": "SILENT", "5": "NEXT" };
        if (map[event.key]) sync(engine?.react({ input: map[event.key], method: "MANUAL", confidence: 1 }));
      }
      if (event.key === "End") sync(engine?.returnToLive());
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [backlogOpen, engine, snapshot?.status, sync, publicSpaceMode]);
  // Public-space mode blocks spoken reactions, not the local non-verbal click detector.
  // Keeping this active lets users verify tooth-click input on the exact Reaction screen.
  const reactionClickInputActive = snapshot?.status === "WAITING_REACTION" && clickInputEnabled;
  const reactionClickMonitor = useReactionClickInput({
    active: reactionClickInputActive,
    onDetection: useCallback((detection) => {
      if (!engine || snapshot?.status !== "WAITING_REACTION") return;
      setLastClickDetection(detection.input);
      sync(engine.react({ input: detection.input, method: "CLICK_PATTERN", confidence: detection.confidence, capturedAt: new Date().toISOString() }));
    }, [engine, snapshot?.status, sync])
  });
  useEffect(() => {
    if (!lastClickDetection) return;
    const timer = window.setTimeout(() => setLastClickDetection(null), 1800);
    return () => clearTimeout(timer);
  }, [lastClickDetection]);
  if (!work || !engine || !snapshot) return <div className="player-screen"><h1>作品が見つかりません</h1></div>;
  const react = (input: ReactionInput) => sync(engine.react({ input, method: "MANUAL", confidence: 1 }));
  const togglePause = () => { snapshot.status === "PAUSED" ? sync(engine.resume()) : (engine.pause(), sync()); };
  const backlogEntries = liveEntry && liveEntry.index >= snapshot.history.length ? [...snapshot.history, liveEntry] : snapshot.history;
  const reachableMax = Math.max(0, backlogEntries.length - 1);
  const maxPathLength = calculateMaxPathLength(work.scenario);
  const seekValue = snapshot.mode === "HISTORY" && snapshot.historyIndex !== null ? snapshot.historyIndex : Math.min(reachableMax, entry?.index ?? 0);
  const seekTo = (index: number) => {
    const nextIndex = Math.max(0, Math.min(reachableMax, Math.round(index)));
    if (nextIndex < snapshot.history.length) sync(engine.seekHistory(nextIndex));
    else if (snapshot.mode === "HISTORY") sync(engine.returnToLive());
  };
  return <div className={`player-screen ${snapshot.status === "PAUSED" ? "is-paused" : ""}`}>
    <div className="player-backdrop" style={{ backgroundImage: `url(${work.cover})` }} />
    <header className="player-top"><Link to={`/works/${work.workId}/${work.version}`} onClick={() => engine.pause()}>← 終了</Link><div><b>{work.title}</b><span>{snapshot.mode === "HISTORY" ? "履歴を再生中" : snapshot.status === "PAUSED" ? "一時停止" : "再生中"}</span></div><div className="player-top-actions"><button className="backlog-button" onClick={() => setBacklogOpen(true)} aria-expanded={backlogOpen} aria-controls="player-backlog">☰ <span>バックログ</span></button><button onClick={() => setMuted((value) => !value)} aria-label={muted ? "ミュート解除" : "ミュート"}>{muted ? "🔇" : "♬"}</button></div></header>
    <main className="player-stage" aria-live="polite">
      {audioError && <section className="audio-error" role="alert"><b>音声を再生できません</b><p>{audioError}</p><button className="button primary" onClick={() => { setAudioError(""); setAudioRetry((value) => value + 1); }}>音声を再試行</button></section>}
      {snapshot.status === "ENDED" ? <section className="end-panel"><p className="eyebrow">THE END</p><h1>{entry?.displayText}</h1><div><Link className="button primary" to={`/play/${work.workId}/${work.version}${fallback ? "?fallback=1" : ""}`} onClick={() => platform.deleteSession(work.workId, work.version)}>もう一度最初から</Link><Link className="button secondary" to={`/works/${work.workId}/${work.version}/transfer`}>スマホで最初から聴く</Link><Link className="text-link" to="/library">ライブラリへ</Link></div></section> : <>
        <div className="speaker">{entry?.speaker || "　"}</div><p className="dialogue">{entry?.displayText}</p>
        {lastClickDetection && <div className="reaction-detection-flash" role="status">✓ 歯カチを検知</div>}
        {snapshot.status === "WAITING_REACTION" && <section className="reaction-panel"><div className="reaction-label"><i /> {snapshot.pendingReactionConfirmation ? "もう一度確認" : publicSpaceMode ? "ボタンで操作" : "REACTION受付中"} <b>{reactionSeconds}</b></div><p>{snapshot.pendingReactionConfirmation ? "同じ反応をもう一度入力してください" : publicSpaceMode ? "声を使わず、ボタンで反応してください" : "端末内判定またはボタンで、短く反応してください"}</p>{reactionClickInputActive && <ReactionClickMonitor monitor={reactionClickMonitor} />}<div>{publicSpaceMode ? <><button onClick={() => react("CLICK_SINGLE")}><kbd>1</kbd><span>歯カチ</span></button><button onClick={() => react("SILENT")}><kbd>2</kbd><span>反応しない</span></button><button onClick={() => react("NEXT")}><kbd>3</kbd><span>次へ</span></button></> : <><button onClick={() => react("VOICE_YES")}><kbd>1</kbd><span>はい・うん</span></button><button onClick={() => react("VOICE_NO")}><kbd>2</kbd><span>いいえ・やだ</span></button><button onClick={() => react("CLICK_SINGLE")}><kbd>3</kbd><span>歯カチ</span></button><button onClick={() => react("SILENT")}><kbd>4</kbd><span>反応しない</span></button><button onClick={() => react("NEXT")}><kbd>5</kbd><span>次へ</span></button></>}</div></section>}
        {snapshot.status === "WAITING_NEXT" && <button className="next-button" onClick={() => sync(engine.next())}>次へ <span>→</span></button>}
      </>}
    </main>
    {snapshot.status !== "ENDED" && <footer className="player-controls"><button className="round-control" onClick={togglePause} aria-label={snapshot.status === "PAUSED" ? "再開" : "一時停止"}>{snapshot.status === "PAUSED" ? "▶" : "Ⅱ"}</button><div className="timeline"><div className="timeline-head"><span>{formatTime(entry?.timelineMs ?? 0)}</span><span>{work.durationLabel}</span></div><HistorySeekbar maxPathLength={maxPathLength} reachableCount={backlogEntries.length} value={seekValue} isHistory={snapshot.mode === "HISTORY"} onSeek={seekTo} /><div className="seek-hint">ドラッグ／スワイプで前のセリフへ</div>{snapshot.mode === "HISTORY" && <button className="live-return" onClick={() => sync(engine.returnToLive())}>LIVEへ戻る</button>}</div></footer>}
    {backlogOpen && <BacklogDialog entries={backlogEntries} historyLength={snapshot.history.length} activeIndex={snapshot.mode === "HISTORY" ? snapshot.historyIndex : entry?.index ?? null} onSeek={(index) => { seekTo(index); setBacklogOpen(false); }} onClose={() => setBacklogOpen(false)} />}
  </div>;
}

function HistorySeekbar({ maxPathLength, reachableCount, value, isHistory, onSeek }: { maxPathLength: number; reachableCount: number; value: number; isHistory: boolean; onSeek: (index: number) => void }) {
  const reachableRatio = Math.min(100, (reachableCount / Math.max(1, maxPathLength)) * 100);
  const playheadRatio = isHistory && reachableCount > 1 ? ((value + 1) / reachableCount) * 100 : 100;
  const seekMax = Math.max(0, reachableCount - 1);

  return <div className="feedback-track-container" data-reachable-percent={Math.round(reachableRatio)}>
    <div className="feedback-track-line" aria-hidden="true">
      <div className="reachable-track" style={{ width: `${reachableRatio}%` }}>
        <div className="playhead-fill" style={{ width: `${playheadRatio}%` }} />
      </div>
    </div>
    <input className="feedback-track-input" type="range" min={0} max={seekMax} step={1} value={Math.min(value, seekMax)} onChange={(event) => onSeek(Number(event.currentTarget.value))} disabled={seekMax === 0} aria-label="セリフのシークバー" aria-valuetext={`${value + 1} / ${reachableCount} セリフ`} />
  </div>;
}

function calculateMaxPathLength(scenario: Scenario): number {
  const nodes = new Map(scenario.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (nodeId: string): number => {
    if (memo.has(nodeId)) return memo.get(nodeId)!;
    if (visiting.has(nodeId)) return 0;
    const node = nodes.get(nodeId);
    if (!node) return 0;

    visiting.add(nodeId);
    let successors: string[] = [];
    if ("next" in node && node.next) successors = [node.next];
    else if (node.type === "reaction_prompt") successors = [...new Set(Object.values(node.reaction_window.branches))];
    else if (node.type === "branch") successors = [...new Set([...node.variants.map((variant) => variant.next), node.fallback])];
    const length = 1 + (successors.length ? Math.max(...successors.map(visit)) : 0);
    visiting.delete(nodeId);
    memo.set(nodeId, length);
    return length;
  };

  return Math.max(1, visit(scenario.entry_node));
}

const formatTime = (milliseconds: number) => `${String(Math.floor(milliseconds / 60_000)).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}`;

function BacklogDialog({ entries, historyLength, activeIndex, onSeek, onClose }: { entries: ResolvedHistoryEntry[]; historyLength: number; activeIndex: number | null; onSeek: (index: number) => void; onClose: () => void }) {
  return <div className="backlog-overlay" onClick={onClose}>
    <section id="player-backlog" className="backlog-dialog" role="dialog" aria-modal="true" aria-labelledby="player-backlog-title" onClick={(event) => event.stopPropagation()}>
      <header className="backlog-header"><div><p className="eyebrow">DIALOGUE LOG</p><h2 id="player-backlog-title">バックログ</h2><span>これまでのセリフを読み返せます</span></div><button className="backlog-close" onClick={onClose} aria-label="バックログを閉じる">×</button></header>
      <ol className="backlog-list">
        {entries.length === 0 ? <li className="backlog-empty">まだセリフがありません。</li> : entries.map((item) => {
          const isCurrent = item.index >= historyLength;
          const isActive = activeIndex === item.index;
          return <li key={`${item.nodeId}-${item.index}`} className={`${isActive ? "active" : ""} ${isCurrent ? "current" : ""}`}>
            <button disabled={isCurrent && activeIndex !== null && activeIndex === item.index} onClick={() => onSeek(item.index)}>
              <span className="backlog-meta"><b>{item.speaker || "　"}</b><time>{formatTime(item.timelineMs)}</time>{isCurrent && <em>現在</em>}</span>
              <span className="backlog-text">{item.displayText || "　"}</span>
            </button>
          </li>;
        })}
      </ol>
      <footer className="backlog-footer"><span>セリフを選ぶと、その場面を一時停止で表示します。</span><button onClick={onClose}>閉じる</button></footer>
    </section>
  </div>;
}

function ReactionClickMonitor({ monitor }: { monitor: ReturnType<typeof useReactionClickInput> }) {
  return <div className="reaction-click-monitor" aria-live="polite">
    <div className="reaction-click-monitor-head"><span><i /> 歯カチ入力モニター</span><b>{clickStateCopy(monitor.state)}</b></div>
    <div className="reaction-click-meter" role="meter" aria-label="歯カチ入力レベル" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(monitor.level * 100)}>
      <i className="reaction-click-threshold" style={monitor.threshold === null ? undefined : { left: `${monitor.threshold * 100}%` }} />
      <i className="reaction-click-level" style={{ width: `${Math.max(1, monitor.level * 100)}%` }} />
    </div>
        <div className="reaction-score-head"><span>歯カチスコア</span><b>{monitor.scoreDebug ? `${Math.round(monitor.scoreDebug.score * 100)} / 100` : "校正中"}</b></div>
        <div className="reaction-score-meter" role="meter" aria-label="歯カチスコア" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((monitor.scoreDebug?.score ?? 0) * 100)}><i style={{ width: `${Math.max(1, (monitor.scoreDebug?.score ?? 0) * 100)}%` }} /></div>
        <small>{monitor.state === "listening" ? `判定閾値 ${Math.round((monitor.scoreDebug?.minimumScore ?? 0) * 100)}。音量・波形特徴を合成しています` : "周囲の音を校正しています。音声は保存・送信しません"}</small>
        {monitor.scoreDebug && <small className="reaction-score-details">RMS {monitor.scoreDebug.rms.toFixed(3)} / peak {monitor.scoreDebug.features?.peak.toFixed(3) ?? "--"} / crest {monitor.scoreDebug.features?.crestFactor.toFixed(1) ?? "--"} / HF {monitor.scoreDebug.features?.highFrequencyRatio.toFixed(2) ?? "--"}</small>}
  </div>;
}

function clickStateCopy(state: ReturnType<typeof useReactionClickInput>["state"]): string {
  if (state === "requesting") return "歯カチ入力：マイクを開始しています";
  if (state === "calibrating") return "歯カチ入力：周囲の音を校正中…";
  if (state === "listening") return "歯カチ入力：軽く1回、歯を鳴らしてください";
  if (state === "denied") return "歯カチ入力：マイク権限が必要です（ボタン入力は使えます）";
  if (state === "missing") return "歯カチ入力：マイクが見つかりません（ボタン入力は使えます）";
  if (state === "busy") return "歯カチ入力：ほかのアプリがマイクを使用中です";
  if (state === "unsupported") return "歯カチ入力：この環境ではマイク入力を使えません";
  return "歯カチ入力：開始できませんでした（ボタン入力は使えます）";
}
