import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { platform, subscribeDeepLinks } from "../lib/platform";
import type { LocalWork } from "../types";

interface WorksContextValue { works: LocalWork[]; loading: boolean; getWork(id?: string, version?: string): LocalWork | undefined }
const WorksContext = createContext<WorksContextValue>({ works: [], loading: true, getWork: () => undefined });

export function WorksProvider({ children }: { children: ReactNode }) {
  const [works, setWorks] = useState<LocalWork[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { platform.worksList().then(setWorks).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    let dispose = () => {};
    subscribeDeepLinks((workId) => location.assign(`/open/${encodeURIComponent(workId)}`)).then((fn) => { dispose = fn; });
    return () => dispose();
  }, []);
  const value = useMemo<WorksContextValue>(() => ({
    works, loading, getWork: (id, version) => works.find((work) => work.workId === id && (!version || work.version === version))
  }), [works, loading]);
  return <WorksContext.Provider value={value}>{children}</WorksContext.Provider>;
}

export const useWorks = () => useContext(WorksContext);
