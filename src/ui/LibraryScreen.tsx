import { useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { platform } from "../lib/platform";
import { loadPnePackageFile } from "../lib/pne-loader";
import { PageHeader, StatusPill } from "./shared";
import { useWorks } from "./works-context";

export function LibraryScreen() {
  const { works, loading, addWork } = useWorks();
  const navigate = useNavigate();
  const pneInputRef = useRef<HTMLInputElement>(null);
  const [importState, setImportState] = useState<"idle" | "loading" | "error">("idle");
  const [importMessage, setImportMessage] = useState("");

  const openPne = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportState("loading");
    setImportMessage(`${file.name} を検証しています…`);
    try {
      const work = await loadPnePackageFile(file);
      addWork(work);
      setImportState("idle");
      setImportMessage(`${work.title} をライブラリへ読み込みました。`);
      navigate(`/works/${work.workId}/${work.version}`);
    } catch (error) {
      setImportState("error");
      setImportMessage(error instanceof Error ? error.message : "完成版.pneを読み込めませんでした。");
    }
  };

  return <div className="page library-page">
    <PageHeader eyebrow="YOUR STORIES" title="ライブラリ">
      <label className="button secondary pne-open-button">完成版.pneを開く<input ref={pneInputRef} type="file" accept=".pne,application/vnd.pne.package+zip,application/zip" hidden onChange={(event) => void openPne(event)} /></label>
    </PageHeader>
    {importMessage && <div className={`pne-import-notice ${importState}`} role={importState === "error" ? "alert" : "status"}><span>{importState === "loading" ? "◌" : importState === "error" ? "!" : "✓"}</span><p>{importMessage}</p>{importState === "error" && <button onClick={() => { setImportState("idle"); setImportMessage(""); pneInputRef.current?.click(); }}>もう一度選ぶ</button>}</div>}
    <div className="library-summary"><span>{works.length} 作品</span><span className="local-only"><i />オフライン再生対応</span></div>
    {loading ? <div className="loading-panel" role="status">作品を読み込んでいます…</div> : <section className="work-grid" aria-label="ローカル作品">
      {works.map((work) => <Link className="work-card" key={`${work.workId}:${work.version}`} to={`/works/${work.workId}/${work.version}`}>
        <div className="cover-wrap"><img src={work.cover} alt="" /><StatusPill state={work.state} /><div className="cover-glow" /></div>
        <div className="work-card-body"><p className="card-kicker">INTERACTIVE AUDIO</p><h2>{work.title}</h2><p>{work.author}</p>
          <div className="meta-row"><span>◷ {work.durationLabel}</span><span>{work.capabilities.name_call_supported ? "名前呼び対応" : "名前なし"}</span></div>
        </div>
      </Link>)}
      <button className="add-card" onClick={() => platform.openPortal()}><span>＋</span><b>新しい物語を見つける</b><small>P.N.E. ポータルを開く</small></button>
    </section>}
    <section className="welcome-strip"><div><span className="spark">✦</span><div><h2>耳を澄ませて、物語の中へ。</h2><p>ヘッドホン推奨。再生中は画面を見なくても操作できます。</p></div></div><span>名前・読み・生成音声はP.N.E.サーバーへ送信されません。</span></section>
  </div>;
}
