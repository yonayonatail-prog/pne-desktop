import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { platform } from "../lib/platform";
import type { StoredSession } from "../types";
import { BackLink, StatusPill } from "./shared";
import { useWorks } from "./works-context";

export function WorkScreen() {
  const { workId, version } = useParams(); const { getWork } = useWorks(); const work = getWork(workId, version);
  const [saved, setSaved] = useState<StoredSession | null>(null);
  useEffect(() => { if (work) platform.loadSession(work.workId, work.version).then(setSaved); }, [work]);
  if (!work) return <div className="page"><BackLink to="/library">ライブラリ</BackLink><h1>作品が見つかりません</h1></div>;
  return <div className="page work-page">
    <BackLink to="/library">ライブラリに戻る</BackLink>
    <section className="work-hero">
      <div className="work-cover-large"><img src={work.cover} alt={`${work.title} 表紙`} /><div className="cover-glow" /></div>
      <div className="work-copy"><StatusPill state={work.state} /><p className="eyebrow">POCKET NARRATIVE</p><h1>{work.title}</h1><p className="author">{work.author}</p><p className="description">{work.description}</p>
        <div className="spec-grid"><div><span>作品バージョン</span><b>{work.version}</b></div><div><span>再生時間</span><b>{work.durationLabel}</b></div><div><span>データ</span><b>{work.sizeLabel}</b></div></div>
        <div className="capabilities"><span>✓ オフライン再生</span><span>✓ 名前呼び</span><span>✓ Reaction分岐</span><span>✓ スマホ転送</span></div>
        <div className="hero-actions">{saved && saved.snapshot.status !== "ENDED" && <Link className="button primary large" to={`/play/${work.workId}/${work.version}?resume=1`}>続きから <span>→</span></Link>}<Link className={saved ? "button secondary" : "button primary large"} to={`/works/${work.workId}/${work.version}/name`}>{saved ? "最初から準備" : "名前を設定する"} <span>→</span></Link><Link className="button secondary" to={`/play/${work.workId}/${work.version}?fallback=1&restart=1`} onClick={() => platform.deleteSession(work.workId, work.version)}>名前なしで始める</Link></div>
      </div>
    </section>
    <section className="preflight-panel"><h2>再生の準備</h2><div className="check-row"><span className="check-icon">✓</span><div><b>作品データ</b><small>検証済み・このPCに保存されています</small></div><strong>準備完了</strong></div><div className="check-row warn"><span className="check-icon">◇</span><div><b>Irodori名前音声モデル</b><small>名前画面から固定リビジョンのモデル約1.3GBを取得し、このPCのWebGPUで生成します</small></div><strong>名前画面で確認</strong></div></section>
  </div>;
}
