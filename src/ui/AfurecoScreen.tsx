import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import type { AfurecoProject } from "../afureco/types";
import { parseAfurecoProjectJson } from "../lib/afureco-import";
import { listTakes } from "../lib/afureco-storage";
import { listAfurecoProjects, saveAfurecoProject } from "../lib/afureco-project-storage";
import { platform } from "../lib/platform";
import { EmptyState, PageHeader } from "./shared";

export function AfurecoScreen() {
  const [projects, setProjects] = useState<AfurecoProject[]>([]);
  const [progress, setProgress] = useState<Record<string, { takeCount: number; completed: boolean }>>({});
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refreshProjects = useCallback(async () => {
    const nextProjects = await listAfurecoProjects();
    setProjects(nextProjects);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refreshProjects().catch(() => {
      setLoading(false);
      setError("アフレコ案件を読み込めませんでした。");
    });
  }, [refreshProjects]);

  useEffect(() => {
    let active = true;
    Promise.all(projects.map(async (project) => {
      const takes = await listTakes(project.projectId);
      return [project.projectId, { takeCount: takes.length, completed: new Set(takes.map((take) => take.lineId)).size >= project.lines.length }] as const;
    }))
      .then((entries) => { if (active) setProgress(Object.fromEntries(entries)); })
      .catch(() => { /* an empty local store is a valid first-run state */ });
    return () => { active = false; };
  }, [projects]);

  const importProject = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    setMessage("");
    setError("");
    try {
      const project = parseAfurecoProjectJson(await file.text(), file.name);
      await saveAfurecoProject(project);
      await refreshProjects();
      setMessage(`${project.workTitle} を読み込みました（${project.lines.length}セリフ）。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "JSONを読み込めませんでした。");
    } finally {
      setImporting(false);
    }
  };

  return <div className="page afureco-page">
    <PageHeader eyebrow="RECORDING WORKSPACE" title="アフレコ">
      <div className="afureco-toolbar"><label className="button secondary">{importing ? "JSONを読み込み中…" : "JSONを読み込む"}<input type="file" accept=".json,application/json" hidden onChange={(event) => void importProject(event)} disabled={importing} /></label><button className="button secondary" onClick={() => void platform.openPortal()}>Webポータルを開く</button></div>
    </PageHeader>
    {message && <p className="afureco-import-message" role="status">{message}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <section className="afureco-intro"><div><p className="eyebrow">LOCAL-FIRST RECORDING</p><h2>声を、セリフ単位で残す。</h2><p>収録データはまずこのPC内へ保存されます。通信がない状態でも録音でき、あとから提出キューへ送れます。</p></div><span className="afureco-lock">♢<small>LOCAL</small></span></section>
    <div className="afureco-summary"><span>{projects.length} 案件</span><span className="local-only"><i />ローカル保存を優先</span></div>
    {loading ? <EmptyState title="案件を読み込んでいます">少しお待ちください。</EmptyState> : <section className="afureco-project-grid" aria-label="アフレコ案件一覧">
      {projects.map((project) => <Link className="afureco-project-card" key={project.projectId} to={`/afureco/projects/${encodeURIComponent(project.projectId)}`}>
        <div className="afureco-card-top"><span className={`afureco-state ${(progress[project.projectId]?.completed ?? false) ? "completed" : ""}`}><i />{progress[project.projectId]?.completed ? "収録完了" : "収録中"}</span><span>v{project.scriptVersion.replace("script-v", "")}</span></div>
        <p className="card-kicker">{project.workTitle}</p><h2>{project.projectName}</h2><p>{project.assignedCharacter} / {project.actorName}</p>
        <div className="afureco-card-meta"><span>セリフ {project.lines.length}件</span><span>テイク {progress[project.projectId]?.takeCount ?? 0}件</span></div>{project.sourceFileName && <small className="afureco-source-file">読込元：{project.sourceFileName}</small>}
        <div className="afureco-card-footer"><span>詳細を開く</span><b>→</b></div>
      </Link>)}
    </section>}
    <section className="notice-panel"><b>JSONから案件を読み込む</b><p>制作画面の台本JSON、statekitの nodes / scenario.nodes、または lines を含むJSONに対応しています。読み込んだ案件と収録テイクはこのPC内に保存されます。</p></section>
  </div>;
}
