import { useMemo, useState } from "react";

export function MobileImportScreen() {
  const preview = useMemo(() => { const raw = new URLSearchParams(location.hash.slice(1)).get("preview"); if (!raw) return null; try { return JSON.parse(decodeURIComponent(raw)) as { work_id: string; work_version: string }; } catch { return null; } }, []);
  const [file, setFile] = useState<File | null>(null);
  return <main className="mobile-import"><img src="/logo.PNG" alt="P.N.E." /><p className="eyebrow">SECURE MOBILE IMPORT</p><h1>スマホで物語を聴く</h1>{preview && <div className="dev-badge">開発preview: {preview.work_id} / {preview.work_version}</div>}<section><h2>転送ファイルを選択</h2><p>PCから保存した <code>.pne-transfer</code> を選んでください。ファイルはサーバーへ送信されません。</p><label className="file-picker"><input type="file" accept=".pne-transfer,application/octet-stream" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span>{file ? file.name : "ファイルを選ぶ"}</span></label>{file && <div className="inline-error">この開発previewでは復号鍵・正式Web release APIが未設定のため、取り込みをcommitできません。</div>}</section><footer>名前音声はこの端末内でのみ復号・保存されます。</footer></main>;
}
