import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { DrawerContext, type StoreDrawerTab } from "./DrawerContext";
import { StoreDrawer } from "./StoreDrawer";

const ScriptDrawer = lazy(() => import("./ScriptDrawer").then((module) => ({ default: module.ScriptDrawer })));

// Drawers must always stay below the fixed .modal-backdrop z-index (100, styles.css)
// so nested Modals (enrollment log, WAF manager, ...) render on top of their owning
// drawer. Only two drawers can ever be open at once (store, script), so a bounded
// two-value toggle - not an ever-incrementing counter - is used to track which one
// was opened/reopened most recently.
const DRAWER_Z_BASE = 90;
const DRAWER_Z_TOP = 91;

export function DrawerProvider({ children }: { children: ReactNode }) {
  const lastOpened = useRef<"store" | "script" | null>(null);
  const [storeDrawer, setStoreDrawer] = useState<{ id: string; tab: StoreDrawerTab } | null>(null);
  const [scriptDrawer, setScriptDrawer] = useState<{ id: string; version: number | null; bulkRunId: string | null } | null>(null);

  const api = useMemo(() => ({
    openStoreDrawer: (storeId: string, tab: StoreDrawerTab = "overall") => {
      lastOpened.current = "store";
      setStoreDrawer({ id: storeId, tab });
    },
    openScriptDrawer: (scriptId: string, version: number | null = null, options?: { bulkRunId?: string | undefined }) => {
      lastOpened.current = "script";
      setScriptDrawer({ id: scriptId, version, bulkRunId: options?.bulkRunId ?? null });
    }
  }), []);
  const storeZIndex = lastOpened.current === "store" ? DRAWER_Z_TOP : DRAWER_Z_BASE;
  const scriptZIndex = lastOpened.current === "script" ? DRAWER_Z_TOP : DRAWER_Z_BASE;

  return (
    <DrawerContext.Provider value={api}>
      {children}
      <StoreDrawer
        storeId={storeDrawer?.id ?? null}
        tab={storeDrawer?.tab ?? "overall"}
        onTabChange={(tab) => setStoreDrawer((current) => (current ? { ...current, tab } : current))}
        onClose={() => setStoreDrawer(null)}
        zIndex={storeZIndex}
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
