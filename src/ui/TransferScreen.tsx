import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useParams } from "react-router-dom";
import { platform } from "../lib/platform";
import { BackLink } from "./shared";
import { useWorks } from "./works-context";

interface Transfer { url: string; expiresAt: string; taskId: string }

export function TransferScreen() {
  const { workId, version } = useParams(); const { getWork } = useWorks(); const work = getWork(workId, version);
  const [transfer, setTransfer] = useState<Transfer | null>(null); const [state, setState] = useState<"IDLE" | "PREPARING" | "WAITING" | "STOPPED" | "ERROR">("IDLE");
  const [seconds, setSeconds] = useState(0); const [copied, setCopied] = useState(false); const [error, setError] = useState("");
  useEffect(() => {
    if (!transfer) return;
    const tick = () => { const deadline = /^\d+$/.test(transfer.expiresAt) ? Number(transfer.expiresAt) : Date.parse(transfer.expiresAt); setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000))); };
    tick(); const interval = setInterval(tick, 500); return () => clearInterval(interval);
  }, [transfer]);
  useEffect(() => () => { if (transfer) platform.stopTransfer(transfer.taskId).catch(() => {}); }, [transfer]);
  if (!work) return <div className="page"><h1>作品が見つかりません</h1></div>;
  const start = async () => { setState("PREPARING"); setError(""); try { const result = await platform.startTransfer(work.workId, work.version); setTransfer(result); setState("WAITING"); } catch (reason) { setError(reason instanceof Error ? reason.message : "転送を開始できません"); setState("ERROR"); } };
  const stop = async () => { if (transfer) await platform.stopTransfer(transfer.taskId); setTransfer(null); setState("STOPPED"); };
  return <div className="page transfer-page"><BackLink to={`/works/${work.workId}/${work.version}`}>作品の準備に戻る</BackLink><p className="eyebrow">MOBILE TRANSFER</p><h1>スマホで最初から聴く</h1><p className="lead">名前音声だけを暗号化して同じ家庭内ネットワークへ一時転送します。PCのセーブや現在位置は含みません。</p>
    <section className="transfer-layout"><div className="transfer-main">
      {!transfer ? <div className="transfer-empty"><div className="phone-glyph">▯</div><h2>{state === "PREPARING" ? "転送データを準備中…" : "スマホとPCを同じネットワークへ"}</h2><p>PCは有線LANでも構いません。VPNまたはPublicネットワークでは接続できない場合があります。</p><button className="button primary large" disabled={state === "PREPARING"} onClick={start}>{state === "PREPARING" ? "準備しています" : "QRコードを作成"}</button>{error && <div className="inline-error">{error}</div>}</div> : <div className="qr-panel"><div className="qr-wrap"><QRCodeSVG value={transfer.url} size={240} level="M" bgColor="#ffffff" fgColor="#180b23" /></div><div className="countdown"><span>有効期限</span><b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</b></div><p>スマホのカメラで読み取ってください。PCプレイヤーを閉じないでください。</p><div className="url-copy"><code>{transfer.url.replace(/#.+$/, "#…")}</code><button onClick={async () => { await navigator.clipboard.writeText(transfer.url); setCopied(true); }}>{copied ? "コピー済み" : "URLをコピー"}</button></div><button className="danger-link" onClick={stop}>転送を停止</button></div>}
    </div><aside className="transfer-steps"><h2>スマホでの手順</h2><ol><li><b>QRコードを読み取る</b><span>PCから暗号化ファイルを保存します</span></li><li><b>スマホWebプレイヤーを開く</b><span>保存したファイルを自分で選択します</span></li><li><b>最初から再生する</b><span>名前音声は端末内でだけ復号されます</span></li></ol><div className="privacy-card"><span>⌁</span><div><b>直接転送</b><small>P.N.E.サーバーへ名前音声をアップロードしません。</small></div></div></aside></section>
  </div>;
}
