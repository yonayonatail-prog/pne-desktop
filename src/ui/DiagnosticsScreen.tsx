import { useEffect, useState } from "react";
import { platform } from "../lib/platform";
import type { DiagnosticsSnapshot } from "../types";
import { PageHeader } from "./shared";

export function DiagnosticsScreen() {
  const [data, setData] = useState<DiagnosticsSnapshot | null>(null);
  useEffect(() => { platform.diagnostics().then(setData); }, []);
  return <div className="page diagnostics-page"><PageHeader eyebrow="SYSTEM" title="診断"><button className="button secondary" onClick={() => platform.diagnostics().then(setData)}>再チェック</button></PageHeader>
    {!data ? <div className="loading-panel">確認しています…</div> : <><section className="diagnostic-grid"><Diagnostic label="アプリ" value={`v${data.appVersion}`} ok /><Diagnostic label="実行環境" value={data.tauri ? "Tauri / WebView2" : "ブラウザ preview"} ok={data.tauri} /><Diagnostic label="WebGPU" value={data.webGpu === "available" ? "利用可能" : "利用不可"} ok={data.webGpu === "available"} /><Diagnostic label="名前音声モデル" value={data.modelState === "READY" ? "取得済み" : data.modelState === "PARTIAL" ? "一部取得済み" : "未取得"} ok={data.modelState === "READY"} /></section>
      <section className="settings-section"><h2>環境情報</h2><dl className="diagnostic-list"><div><dt>Platform</dt><dd>{data.platform}</dd></div><div><dt>WebView</dt><dd>{data.webview}</dd></div><div><dt>ローカル保存</dt><dd>{data.storageBytes.toLocaleString()} bytes</dd></div><div><dt>Release設定</dt><dd>{data.releaseConfiguration}</dd></div></dl></section>
      {data.releaseConfiguration === "DEVELOPMENT" && <section className="notice-panel warning"><b>開発設定で実行中</b><p>Catalog API、CDN allowlist、updater署名鍵、音声許諾鍵は未設定です。production配布はできません。</p></section>}</>}
  </div>;
}

function Diagnostic({ label, value, ok }: { label: string; value: string; ok: boolean }) { return <article className="diagnostic-card"><span className={ok ? "ok" : "warn"}>{ok ? "✓" : "!"}</span><div><small>{label}</small><b>{value}</b></div></article>; }
