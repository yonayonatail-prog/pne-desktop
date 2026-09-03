import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { platform, subscribeDeepLinks } from "../lib/platform";
import type { LocalWork } from "../types";

interface WorksContextValue {
  works: LocalWork[];
  loading: boolean;
  getWork(id?: string, version?: string): LocalWork | undefined;
  addWork(work: LocalWork): void;
}
const WorksContext = createContext<WorksContextValue>({ works: [], loading: true, getWork: () => undefined, addWork: () => {} });

export function WorksProvider({ children }: { children: ReactNode }) {
  const [works, setWorks] = useState<LocalWork[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { platform.worksList().then(setWorks).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    let dispose = () => {};
    subscribeDeepLinks((workId) => location.assign(`/open/${encodeURIComponent(workId)}`)).then((fn) => { dispose = fn; });
    return () => dispose();
  }, []);
  const addWork = useCallback((work: LocalWork) => setWorks((current) => [
    work,
    ...current.filter((candidate) => !(candidate.workId === work.workId && candidate.version === work.version))
  ]), []);
  const value = useMemo<WorksContextValue>(() => ({
    works, loading,
    getWork: (id, version) => works.find((work) => work.workId === id && (!version || work.version === version)),
    addWork
  }), [works, loading, addWork]);
  return <WorksContext.Provider value={value}>{children}</WorksContext.Provider>;
}

export const useWorks = () => useContext(WorksContext);
