import { useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { buildEditablePnepack, buildPnePackage, readStoredZip, scanProject, type PnePackIssue, type ProjectFile, type ScannedProject } from "../../packages/pne-pack/src";
import type { PneLicense } from "../../packages/pne-schema/src";
import { unlockAudioPlayback } from "../lib/audio-playback";
import { loadPnePackageBytes } from "../lib/pne-loader";
import { useWorks } from "./works-context";

type SaveFileHandle = { createWritable: () => Promise<{ write: (contents: string | Uint8Array) => Promise<void>; close: () => Promise<void> }> };
type WindowWithSavePicker = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<SaveFileHandle>;
};
type DirectoryFileEntry = { kind: "file"; name: string; getFile: () => Promise<File> };
type DirectoryEntry = DirectoryFileEntry | { kind: "directory"; name: string; values: () => AsyncIterable<DirectoryEntry> };
type DirectoryHandle = Extract<DirectoryEntry, { kind: "directory" }>;
type WindowWithDirectoryPicker = Window & { showDirectoryPicker?: () => Promise<DirectoryHandle> };
type PickedProjectFile = { path: string; file: File };

const DEFAULT_LICENSE: PneLicense = {
  license_id: "PNE-UNSPECIFIED",
  allow_audio_addition: true,
  allow_external_distribution: false,
  allow_external_sale: false,
  credit_required: true
};

function parseJson(input: string | Uint8Array, filename: string): unknown {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  try { return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown; }
  catch (error) { throw new Error(`${filename}: JSONを読み込めません（${error instanceof Error ? error.message : String(error)}）`); }
}

function relativeProjectPath(file: File): string {
  const relative = file.webkitRelativePath || file.name;
  const parts = relative.replaceAll("\\", "/").split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : parts[0];
}

async function filesFromPickedFiles(pickedFiles: PickedProjectFile[]): Promise<{ files: ProjectFile[]; statekitPack: unknown; license?: PneLicense }> {
  const projectFiles = await Promise.all(pickedFiles.map(async ({ path, file }) => ({ path, bytes: new Uint8Array(await file.arrayBuffer()), file })));
  const stateFile = projectFiles.find((entry) => entry.path === "pne_statekit_pack.json");
  if (!stateFile) throw new Error("pne_statekit_pack.jsonが見つかりません。作品フォルダのルートを読み込んでください。");
  const licenseFile = projectFiles.find((entry) => entry.path === "license.json");
  const parsedLicense = licenseFile ? parseJson(new TextDecoder().decode(licenseFile.bytes), "license.json") : undefined;
  const license = parsedLicense && typeof parsedLicense === "object" ? parsedLicense as PneLicense : undefined;
  return { files: projectFiles.map(({ path, bytes }) => ({ path, bytes })), statekitPack: parseJson(new TextDecoder().decode(stateFile.bytes), "pne_statekit_pack.json"), license };
}

async function filesFromInput(files: FileList): Promise<{ files: ProjectFile[]; statekitPack: unknown; license?: PneLicense }> {
  return filesFromPickedFiles([...files].map((file) => ({ path: relativeProjectPath(file), file })));
}

async function filesFromDirectory(directory: DirectoryHandle): Promise<{ files: ProjectFile[]; statekitPack: unknown; license?: PneLicense }> {
  const pickedFiles: PickedProjectFile[] = [];
  const walk = async (current: DirectoryHandle, prefix: string): Promise<void> => {
    for await (const entry of current.values()) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "file") pickedFiles.push({ path, file: await entry.getFile() });
      else await walk(entry, path);
    }
  };
  await walk(directory, "");
  return filesFromPickedFiles(pickedFiles);
}

async function filesFromPnepack(file: File): Promise<{ files: ProjectFile[]; statekitPack: unknown; license?: PneLicense }> {
  const entries = readStoredZip(new Uint8Array(await file.arrayBuffer()));
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  const stateEntry = entries.find((entry) => entry.path === "pne_statekit_pack.json");
  if (!manifestEntry || !stateEntry) throw new Error("編集用.pnepackではありません。manifest.jsonとpne_statekit_pack.jsonが必要です。");
  const manifest = parseJson(manifestEntry.bytes, "manifest.json");
  if (!manifest || typeof manifest !== "object" || (manifest as { format?: unknown }).format !== "pnepack") throw new Error("完成版.pneは編集画面で開けません。編集用.pnepackを選択してください。");
  const licenseEntry = entries.find((entry) => entry.path === "license.json");
  const parsedLicense = licenseEntry ? parseJson(licenseEntry.bytes, "license.json") : undefined;
  const license = parsedLicense && typeof parsedLicense === "object" ? parsedLicense as PneLicense : undefined;
  return { files: entries.map(({ path, bytes }) => ({ path, bytes })), statekitPack: parseJson(stateEntry.bytes, "pne_statekit_pack.json"), license };
}

function saveArchive(bytes: Uint8Array, filename: string): Promise<void> {
  const picker = (window as WindowWithSavePicker).showSaveFilePicker;
  if (picker) {
    return picker({ suggestedName: filename, types: [{ description: "P.N.E. パッケージ", accept: { "application/octet-stream": [filename.endsWith(".pnepack") ? ".pnepack" : ".pne"] } }] })
      .then(async (handle) => { const writable = await handle.createWritable(); await writable.write(bytes); await writable.close(); });
  }
  const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return Promise.resolve();
}

function issueLabel(item: PnePackIssue): string {
  return `${item.code}：${item.message}${item.path ? `（${item.path}）` : ""}`;
}

function extensionOf(filename: string): string {
  return filename.toLocaleLowerCase("en-US").match(/\.[a-z0-9]+$/)?.[0] || ".wav";
}

export function PnePackScreen() {
  const navigate = useNavigate();
  const { addWork } = useWorks();
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [statekitPack, setStatekitPack] = useState<unknown | null>(null);
  const [scanned, setScanned] = useState<ScannedProject | null>(null);
  const [license, setLicense] = useState<PneLicense>(DEFAULT_LICENSE);
  const [message, setMessage] = useState("作品フォルダを読み込んでください。");
  const [busy, setBusy] = useState(false);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [runtimeWork, setRuntimeWork] = useState<{ workId: string; version: string } | null>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);
  const packInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const applyLoadedProject = async (loaded: { files: ProjectFile[]; statekitPack: unknown; license?: PneLicense }) => {
    const nextLicense = loaded.license ?? DEFAULT_LICENSE;
    const result = await scanProject({ files: loaded.files, statekitPack: loaded.statekitPack, license: nextLicense });
    setProjectFiles(loaded.files); setStatekitPack(loaded.statekitPack); setLicense(nextLicense); setScanned(result);
    return result;
  };

  const applyProject = async (load: () => Promise<{ files: ProjectFile[]; statekitPack: unknown; license?: PneLicense }>) => {
    setBusy(true); setMessage("作品フォルダを読み込んでいます…");
    try {
      const result = await applyLoadedProject(await load());
      const errorCount = result.issues.filter((item) => item.level === "error").length;
      setMessage(errorCount ? `${errorCount}件のエラーがあります。素材を追加して再検証してください。` : "検証できます。必要なら編集用パックを書き出せます。");
    } catch (error) { setScanned(null); setMessage(error instanceof Error ? error.message : "作品フォルダを読み込めませんでした。"); }
    finally { setBusy(false); }
  };

  const selectProject = async () => {
    const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
    if (!picker) { projectInputRef.current?.click(); return; }
    try {
      const directory = await picker();
      await applyProject(() => filesFromDirectory(directory));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setScanned(null); setMessage(error instanceof Error ? error.message : "作品フォルダを読み込めませんでした。");
    }
  };

  const selectProjectFromInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files; event.target.value = "";
    if (!files?.length) return;
    await applyProject(() => filesFromInput(files));
  };

  const selectPnepack = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setBusy(true); setMessage("編集用.pnepackを読み込んでいます…");
    try {
      const result = await applyLoadedProject(await filesFromPnepack(file));
      const errorCount = result.issues.filter((item) => item.level === "error").length;
      setMessage(errorCount ? `${errorCount}件のエラーがあります。素材を追加して補完してください。` : "編集用パックを開きました。完成版を書き出せます。");
    } catch (error) { setScanned(null); setMessage(error instanceof Error ? error.message : "編集用パックを読み込めませんでした。"); }
    finally { setBusy(false); }
  };

  const rescan = async () => {
    if (!statekitPack) return;
    setBusy(true); setMessage("再検証しています…");
    try {
      const result = await scanProject({ files: projectFiles, statekitPack, license });
      setScanned(result); setMessage(result.issues.some((item) => item.level === "error") ? "エラーを確認してください。" : "問題ありません。完成版を書き出せます。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "再検証に失敗しました。"); }
    finally { setBusy(false); }
  };

  const chooseAssetForSlot = (slotId: string) => {
    const slot = scanned?.assetManifest.slots.find((candidate) => candidate.slot_id === slotId);
    setSelectedSlotId(slotId);
    if (slot && assetInputRef.current) assetInputRef.current.accept = slot.kind === "image" ? "image/png,image/jpeg,image/webp" : "audio/wav,audio/mpeg,audio/ogg,audio/webm";
    assetInputRef.current?.click();
  };

  const addAsset = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    const slot = scanned?.assetManifest.slots.find((candidate) => candidate.slot_id === selectedSlotId);
    if (!file || !slot || !statekitPack) return;
    const nextPath = `assets/${slot.kind}/${slot.slot_id}${extensionOf(file.name)}`;
    const nextFiles = [...projectFiles.filter((candidate) => !candidate.path.match(new RegExp(`^assets/${slot.kind}/${slot.slot_id}\\.[^/]+$`))), { path: nextPath, bytes: new Uint8Array(await file.arrayBuffer()) }];
    setProjectFiles(nextFiles); setBusy(true); setMessage(`${slot.label}を追加して再検証しています…`);
    try {
      const result = await scanProject({ files: nextFiles, statekitPack, license });
      setScanned(result); setMessage(result.issues.some((item) => item.level === "error") ? "素材を追加しました。残りのエラーを確認してください。" : "素材を追加しました。完成版を書き出せます。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "素材の追加に失敗しました。"); }
    finally { setBusy(false); setSelectedSlotId(null); }
  };

  const copyDiagnostics = async () => {
    if (!scanned) return;
    const report = { app: "P.N.E. PC Player", package_format: "pnepack/1.0", work_id: scanned.workId, work_version: scanned.workVersion, assets: scanned.assetsFile.assets.length, slots: scanned.assetManifest.slots.length, issues: scanned.issues };
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); setMessage("診断情報をクリップボードへコピーしました。"); }
    catch { setMessage("診断情報をコピーできませんでした。ブラウザの権限を確認してください。"); }
  };

  const exportEditable = async () => {
    if (!statekitPack) return;
    setBusy(true); setMessage("編集用パックを作成しています…");
    try {
      const result = await buildEditablePnepack({ files: projectFiles, statekitPack, license });
      const title = scanned?.title || "pne-project";
      await saveArchive(result.archive, `${title}.pnepack`);
      setMessage("編集用.pnepackを書き出しました。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "編集用パックの作成に失敗しました。"); }
    finally { setBusy(false); }
  };

  const exportRuntime = async () => {
    if (!statekitPack) return;
    setBusy(true); setMessage("完成版.pneを検証・作成しています…");
    try {
      const result = await buildPnePackage({ files: projectFiles, statekitPack, license });
      await saveArchive(result.archive, `${scanned?.title || "pne-project"}.pne`);
      const work = await loadPnePackageBytes(result.archive, `${scanned?.title || "pne-project"}.pne`);
      addWork(work);
      setRuntimeWork({ workId: work.workId, version: work.version });
      setMessage("完成版.pneを書き出しました。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "完成版.pneを作成できませんでした。"); }
    finally { setBusy(false); }
  };

  const errors = scanned?.issues.filter((item) => item.level === "error") ?? [];
  const warnings = scanned?.issues.filter((item) => item.level === "warning") ?? [];
  const directoryInputProps = { webkitdirectory: "", directory: "" } as unknown as Record<string, string>;

  return <div className="page pne-pack-page">
    <header className="page-header"><div><p className="eyebrow">PACKAGE WORKSHOP</p><h1>.pneパッキング</h1><p>作品フォルダを走査し、素材を確認してパッケージを書き出します。</p></div><div className="pne-header-actions"><label className="button secondary">.pnepackを開く<input ref={packInputRef} type="file" accept=".pnepack,application/octet-stream" hidden onChange={selectPnepack} /></label><button type="button" className="button primary" onClick={() => void selectProject()} disabled={busy}>作品フォルダを読み込む</button><input ref={projectInputRef} type="file" multiple hidden {...directoryInputProps} onChange={selectProjectFromInput} /></div></header>
    <section className="pne-pack-status"><span className={errors.length ? "status-error" : "status-ok"}>●</span><b>{scanned?.title || "プロジェクト未選択"}</b><span>{message}</span></section>
    <input ref={assetInputRef} type="file" hidden accept="audio/wav,audio/mpeg,audio/ogg,audio/webm,image/png,image/jpeg,image/webp" onChange={addAsset} />
    {scanned ? <>
      <section className="pne-pack-summary"><div><span>素材</span><strong>{scanned.assetsFile.assets.length}</strong></div><div><span>不足スロット</span><strong>{scanned.assetManifest.slots.filter((slot) => slot.status === "missing").length}</strong></div><div><span>エラー</span><strong>{errors.length}</strong></div><div><span>警告</span><strong>{warnings.length}</strong></div></section>
      <section className="pne-pack-grid">
        <div className="panel"><div className="section-heading"><h2>素材スロット</h2><button className="button compact secondary" onClick={() => void rescan()} disabled={busy}>再検証</button></div><div className="pne-slot-list">{scanned.assetManifest.slots.length ? scanned.assetManifest.slots.map((slot) => <div className={`pne-slot-row ${slot.status}`} key={slot.slot_id}><span className="pne-slot-kind">{slot.kind}</span><div><b>{slot.label}</b><small>{slot.target_path}</small></div><div className="pne-slot-end"><em>{slot.status === "present" ? "設定済み" : "未設定"}</em>{slot.status === "missing" && <button className="button compact secondary" onClick={() => chooseAssetForSlot(slot.slot_id)} disabled={busy}>素材を追加</button>}</div></div>) : <p className="empty-copy">台本から参照されている素材はありません。</p>}</div></div>
        <div className="panel"><div className="section-heading"><h2>ライセンス</h2><span>JSONは不要です</span></div><div className="pne-license-form"><label>ライセンスID<input value={license.license_id} onChange={(event) => setLicense((current) => ({ ...current, license_id: event.target.value }))} /></label><label>クレジット<input value={license.attribution || ""} onChange={(event) => setLicense((current) => ({ ...current, attribution: event.target.value || undefined }))} /></label><label className="check-row"><input type="checkbox" checked={license.allow_audio_addition} onChange={(event) => setLicense((current) => ({ ...current, allow_audio_addition: event.target.checked }))} />声・SEの追加を許可</label><label className="check-row"><input type="checkbox" checked={license.allow_external_distribution} onChange={(event) => setLicense((current) => ({ ...current, allow_external_distribution: event.target.checked }))} />外部配布を許可</label><label className="check-row"><input type="checkbox" checked={license.allow_external_sale} onChange={(event) => setLicense((current) => ({ ...current, allow_external_sale: event.target.checked }))} />外部販売を許可</label><label className="check-row"><input type="checkbox" checked={license.credit_required} onChange={(event) => setLicense((current) => ({ ...current, credit_required: event.target.checked }))} />クレジット表記を求める</label></div></div>
      </section>
      {(errors.length || warnings.length) > 0 && <section className="panel pne-issue-panel"><div className="section-heading"><h2>検証結果</h2><div className="pne-issue-actions"><span>AIへ相談できます</span><button className="button compact secondary" onClick={() => void copyDiagnostics()}>診断情報をコピー</button></div></div><div className="pne-issue-list">{[...errors, ...warnings].slice(0, 20).map((item, index) => <div className={`pne-issue ${item.level}`} key={`${item.code}-${item.path}-${index}`}><b>{item.level === "error" ? "エラー" : "警告"}</b><span>{issueLabel(item)}</span></div>)}</div></section>}
      <section className="pne-pack-actions"><button className="button secondary" onClick={() => void exportEditable()} disabled={busy}>編集用.pnepackを書き出す</button><button className="button primary" onClick={() => void exportRuntime()} disabled={busy || errors.length > 0}>完成版.pneにパッキング</button>{runtimeWork && <button className="button secondary" onClick={() => { void unlockAudioPlayback().catch(() => {}); navigate(`/play/${runtimeWork.workId}/${runtimeWork.version}?fallback=1&restart=1`); }} disabled={busy}>プレイヤーで開く →</button>}</section>
    </> : <section className="panel pne-pack-empty"><h2>まず作品フォルダを読み込みます</h2><p><code>pne_statekit_pack.json</code>と<code>assets/</code>フォルダを含む作品フォルダを読み込んでください。素材マニフェストはTauriが自動生成します。</p></section>}
  </div>;
}
