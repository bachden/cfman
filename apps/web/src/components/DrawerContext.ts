import { createContext, useContext } from "react";

export type TunnelDrawerTab = "overall" | "ingress" | "connect";

export type DrawerApi = {
  openTunnelDrawer: (tunnelId: string, tab?: TunnelDrawerTab, enrollmentId?: string) => void;
  openScriptDrawer: (scriptId: string, version?: number | null, options?: { bulkRunId?: string | undefined }) => void;
};

export const DrawerContext = createContext<DrawerApi | null>(null);

export function useDrawers(): DrawerApi {
  const context = useContext(DrawerContext);
  if (!context) throw new Error("useDrawers must be used within a DrawerProvider");
  return context;
}
