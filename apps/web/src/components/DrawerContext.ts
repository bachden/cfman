import { createContext, useContext } from "react";

export type TunnelDrawerTab = "overall" | "ingress" | "connect";

export type DrawerApi = {
  // `executionId` opens the Connect tab on exactly that execution, whichever
  // page of the history it would otherwise be on.
  openTunnelDrawer: (tunnelId: string, tab?: TunnelDrawerTab, options?: { enrollmentId?: string; executionId?: string }) => void;
  openScriptDrawer: (scriptId: string, version?: number | null, options?: { bulkRunId?: string | undefined }) => void;
  // A null id opens the drawer in create mode; both drawers edit in place otherwise.
  openAutomationRuleDrawer: (ruleId: string | null) => void;
  openChannelDrawer: (channelId: string | null) => void;
};

export const DrawerContext = createContext<DrawerApi | null>(null);

export function useDrawers(): DrawerApi {
  const context = useContext(DrawerContext);
  if (!context) throw new Error("useDrawers must be used within a DrawerProvider");
  return context;
}
