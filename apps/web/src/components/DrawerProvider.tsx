import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { DrawerContext, type TunnelDrawerTab } from "./DrawerContext";
import { DrawerStackProvider } from "./DrawerStack";
import { TunnelDrawer } from "./TunnelDrawer";

const ScriptDrawer = lazy(() => import("./ScriptDrawer").then((module) => ({ default: module.ScriptDrawer })));

const DRAWER_DEFAULT_WIDTH = 1080;

type TunnelDrawerEntry = { tunnelId: string; tab: TunnelDrawerTab; enrollmentId: string | undefined; width: number; openSeq: number };
type ScriptDrawerEntry = { scriptId: string; version: number | null; bulkRunId: string | null; width: number; openSeq: number };

// Each open tunnel/script gets its own stacked drawer instance (keyed by its id), rather than
// a single reused slot per type - opening a second tunnel while the first is still open must
// add a new drawer behind/in front of it, not replace it.
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [tunnelDrawers, setTunnelDrawers] = useState<TunnelDrawerEntry[]>([]);
  const [scriptDrawers, setScriptDrawers] = useState<ScriptDrawerEntry[]>([]);
  const openSeq = useRef(0);

  const api = useMemo(() => ({
    openTunnelDrawer: (tunnelId: string, tab: TunnelDrawerTab = "overall", enrollmentId?: string) => {
      openSeq.current += 1;
      const seq = openSeq.current;
      setTunnelDrawers((current) => {
        const existing = current.find((entry) => entry.tunnelId === tunnelId);
        const next = { tunnelId, tab, enrollmentId, width: existing?.width ?? DRAWER_DEFAULT_WIDTH, openSeq: seq };
        return existing ? current.map((entry) => (entry.tunnelId === tunnelId ? next : entry)) : [...current, next];
      });
    },
    openScriptDrawer: (scriptId: string, version: number | null = null, options?: { bulkRunId?: string | undefined }) => {
      openSeq.current += 1;
      const seq = openSeq.current;
      setScriptDrawers((current) => {
        const existing = current.find((entry) => entry.scriptId === scriptId);
        const next = { scriptId, version, bulkRunId: options?.bulkRunId ?? null, width: existing?.width ?? DRAWER_DEFAULT_WIDTH, openSeq: seq };
        return existing ? current.map((entry) => (entry.scriptId === scriptId ? next : entry)) : [...current, next];
      });
    }
  }), []);

  return (
    <DrawerContext.Provider value={api}>
      {children}
      <DrawerStackProvider>
        {tunnelDrawers.map((entry) => (
          <TunnelDrawer
            key={entry.tunnelId}
            tunnelId={entry.tunnelId}
            tab={entry.tab}
            initialExpandEnrollmentId={entry.enrollmentId ?? null}
            openSeq={entry.openSeq}
            onTabChange={(tab) => setTunnelDrawers((current) => current.map((item) => (item.tunnelId === entry.tunnelId ? { ...item, tab } : item)))}
            onClose={() => setTunnelDrawers((current) => current.filter((item) => item.tunnelId !== entry.tunnelId))}
            width={entry.width}
            onResize={(width) => setTunnelDrawers((current) => current.map((item) => (item.tunnelId === entry.tunnelId ? { ...item, width } : item)))}
          />
        ))}
        <Suspense fallback={null}>
          {scriptDrawers.map((entry) => (
            <ScriptDrawer
              key={entry.scriptId}
              scriptId={entry.scriptId}
              version={entry.version}
              initialBulkRunId={entry.bulkRunId}
              openSeq={entry.openSeq}
              onClose={() => setScriptDrawers((current) => current.filter((item) => item.scriptId !== entry.scriptId))}
              width={entry.width}
              onResize={(width) => setScriptDrawers((current) => current.map((item) => (item.scriptId === entry.scriptId ? { ...item, width } : item)))}
            />
          ))}
        </Suspense>
      </DrawerStackProvider>
    </DrawerContext.Provider>
  );
}
