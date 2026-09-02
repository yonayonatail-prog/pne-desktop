import { SAMPLE_WORKS } from "../data/sample";
import type { DiagnosticsSnapshot, LocalWork, StoredSession } from "../types";
import { getIrodoriModelState } from "./irodori-name-voice";
import type { AuthoringPack } from "../authoring/types";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const platform = {
  isTauri,
  async worksList(): Promise<LocalWork[]> {
    if (isTauri()) {
      try {
        const nativeWorks = await invokeTauri<LocalWork[]>("works_list");
        return [...nativeWorks, ...SAMPLE_WORKS.filter((sample) => !nativeWorks.some((work) => work.workId === sample.workId && work.version === sample.version))];
      } catch { /* development fixtures remain available */ }
    }
    return SAMPLE_WORKS;
  },
  async pendingLaunch(): Promise<string | null> {
    if (!isTauri()) return new URLSearchParams(location.search).get("work_id");
    return invokeTauri<string | null>("launch_get_pending");
  },
  async saveSession(session: StoredSession): Promise<void> {
    if (isTauri()) {
      await invokeTauri("session_save_dev", { session });
      return;
    }
    localStorage.setItem(`pne.session.${session.workId}.${session.workVersion}`, JSON.stringify(session));
  },
  async loadSession(workId: string, version: string): Promise<StoredSession | null> {
    if (isTauri()) return invokeTauri("session_load_dev", { workId, workVersion: version });
    const value = localStorage.getItem(`pne.session.${workId}.${version}`);
    return value ? JSON.parse(value) as StoredSession : null;
  },
  async deleteSession(workId: string, version: string): Promise<void> {
    if (isTauri()) { await invokeTauri("session_delete_dev", { workId, workVersion: version }); return; }
    localStorage.removeItem(`pne.session.${workId}.${version}`);
  },
  async diagnostics(): Promise<DiagnosticsSnapshot> {
    const modelState = await getIrodoriModelState();
    if (isTauri()) {
      const snapshot = await invokeTauri<DiagnosticsSnapshot>("diagnostics_snapshot");
      return { ...snapshot, modelState };
    }
    return {
      appVersion: "0.1.0-dev", tauri: false, platform: navigator.platform,
      webview: navigator.userAgent, webGpu: "gpu" in navigator ? "available" : "unavailable",
      microphone: "unchecked", storageBytes: JSON.stringify(localStorage).length,
      modelState, releaseConfiguration: "DEVELOPMENT"
    };
  },
  async startTransfer(workId: string, version: string): Promise<{ url: string; expiresAt: string; taskId: string }> {
    if (isTauri()) return invokeTauri("transfer_start_dev", { workId, workVersion: version });
    const payload = encodeURIComponent(JSON.stringify({ work_id: workId, work_version: version, mode: "development-preview" }));
    return { url: `${location.origin}/mobile-import#preview=${payload}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), taskId: crypto.randomUUID() };
  },
  async stopTransfer(taskId: string): Promise<void> {
    if (isTauri()) await invokeTauri("transfer_stop_dev", { taskId });
  },
  async openPortal(): Promise<void> {
    if (isTauri()) { await invokeTauri("portal_open", { target: "HOME" }); return; }
    window.open(import.meta.env.VITE_PORTAL_ORIGIN || "https://pne.example.invalid", "_blank", "noopener,noreferrer");
  },
  async authoringSave(projectId: string, pack: AuthoringPack): Promise<void> {
    if (isTauri()) {
      await invokeTauri("authoring_project_save", { projectId, project: pack });
      return;
    }
    localStorage.setItem(`pne.authoring.${projectId}`, JSON.stringify(pack));
  },
  async authoringLoad(projectId: string): Promise<AuthoringPack | null> {
    if (isTauri()) return invokeTauri<AuthoringPack | null>("authoring_project_load", { projectId });
    const value = localStorage.getItem(`pne.authoring.${projectId}`);
    return value ? JSON.parse(value) as AuthoringPack : null;
  }
};

export async function subscribeDeepLinks(onWorkId: (workId: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  const parse = (raw: string) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== "pne:" || url.hostname !== "open" || (url.pathname !== "" && url.pathname !== "/") || url.hash) return;
      const params = [...url.searchParams.entries()];
      if (params.length !== 1 || params[0][0] !== "work_id" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(params[0][1])) return;
      onWorkId(params[0][1]);
    } catch { /* malformed external input is ignored */ }
  };
  (await getCurrent())?.forEach(parse);
  return onOpenUrl((urls) => urls.forEach(parse));
}
