import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { DrawerContext, type TunnelDrawerTab } from "./DrawerContext";
import { TunnelDrawer } from "./TunnelDrawer";

const ScriptDrawer = lazy(() => import("./ScriptDrawer").then((module) => ({ default: module.ScriptDrawer })));

// Drawers must always stay below the fixed .modal-backdrop z-index (100, styles.css)
// so nested Modals (enrollment log, WAF manager, ...) render on top of their owning
// drawer. Only two drawers can ever be open at once (tunnel, script), so a bounded
// two-value toggle - not an ever-incrementing counter - is used to track which one
// was opened/reopened most recently.
const DRAWER_Z_BASE = 90;
const DRAWER_Z_TOP = 91;

export function DrawerProvider({ children }: { children: ReactNode }) {
  const lastOpened = useRef<"tunnel" | "script" | null>(null);
  const [tunnelDrawer, setTunnelDrawer] = useState<{ id: string; tab: TunnelDrawerTab; enrollmentId?: string | undefined } | null>(null);
  const [scriptDrawer, setScriptDrawer] = useState<{ id: string; version: number | null; bulkRunId: string | null } | null>(null);

  const api = useMemo(() => ({
    openTunnelDrawer: (tunnelId: string, tab: TunnelDrawerTab = "overall", enrollmentId?: string) => {
      lastOpened.current = "tunnel";
      setTunnelDrawer({ id: tunnelId, tab, enrollmentId });
    },
    openScriptDrawer: (scriptId: string, version: number | null = null, options?: { bulkRunId?: string | undefined }) => {
      lastOpened.current = "script";
      setScriptDrawer({ id: scriptId, version, bulkRunId: options?.bulkRunId ?? null });
    }
  }), []);
  const tunnelZIndex = lastOpened.current === "tunnel" ? DRAWER_Z_TOP : DRAWER_Z_BASE;
  const scriptZIndex = lastOpened.current === "script" ? DRAWER_Z_TOP : DRAWER_Z_BASE;

  return (
    <DrawerContext.Provider value={api}>
      {children}
      <TunnelDrawer
        tunnelId={tunnelDrawer?.id ?? null}
        tab={tunnelDrawer?.tab ?? "overall"}
        initialExpandEnrollmentId={tunnelDrawer?.enrollmentId ?? null}
        onTabChange={(tab) => setTunnelDrawer((current) => (current ? { ...current, tab } : current))}
        onClose={() => setTunnelDrawer(null)}
        zIndex={tunnelZIndex}
      />
      <Suspense fallback={null}>
        <ScriptDrawer
          scriptId={scriptDrawer?.id ?? null}
          version={scriptDrawer?.version ?? null}
          initialBulkRunId={scriptDrawer?.bulkRunId ?? null}
          onClose={() => setScriptDrawer(null)}
          zIndex={scriptZIndex}
        />
      </Suspense>
    </DrawerContext.Provider>
  );
}
