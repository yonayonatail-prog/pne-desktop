import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageHeader } from "./shared";
import { useWorks } from "./works-context";

export function OpenScreen() {
  const { workId } = useParams(); const navigate = useNavigate(); const { getWork, loading } = useWorks();
  const work = getWork(workId);
  useEffect(() => { if (work) navigate(`/works/${work.workId}/${work.version}`, { replace: true }); }, [work, navigate]);
  return <div className="page"><PageHeader eyebrow="DEEP LINK" title="作品を開いています" />
    <section className="center-state"><div className="spinner" />{loading ? <p>ローカル作品を確認しています…</p> : <><h2>作品が見つかりません</h2><p><code>{workId}</code> はローカルにありません。正式API設定後はここで公開情報を解決します。</p><button className="button primary" onClick={() => location.assign("/library")}>ライブラリへ</button></>}</section>
  </div>;
}
