import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { WorkInstallState } from "../types";

const stateLabel: Record<WorkInstallState, string> = {
  NOT_INSTALLED: "未取得", DOWNLOADING: "ダウンロード中", VERIFYING: "検証中", READY: "再生可能",
  UPDATE_AVAILABLE: "更新あり", CORRUPT: "要修復", INCOMPATIBLE: "非対応"
};

export function StatusPill({ state }: { state: WorkInstallState }) {
  return <span className={`status-pill state-${state.toLowerCase()}`}><i />{stateLabel[state]}</span>;
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1></div>{children}</header>;
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="back-link" to={to}>← {children}</Link>;
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <section className="empty-state"><div className="empty-glyph">P.N.E.</div><h2>{title}</h2><p>{children}</p></section>;
}
