import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { DrawerContext, type TunnelDrawerTab } from "./DrawerContext";
import { DrawerStackProvider } from "./DrawerStack";
import { TunnelDrawer } from "./TunnelDrawer";

const ScriptDrawer = lazy(() => import("./ScriptDrawer").then((module) => ({ default: module.ScriptDrawer })));
const AutomationRuleDrawer = lazy(() => import("./AutomationRuleDrawer").then((module) => ({ default: module.AutomationRuleDrawer })));
const ChannelDrawer = lazy(() => import("./ChannelDrawer").then((module) => ({ default: module.ChannelDrawer })));

const DRAWER_DEFAULT_WIDTH = 1080;

type TunnelDrawerEntry = { key: number; tunnelId: string; tab: TunnelDrawerTab; enrollmentId: string | undefined; width: number; openSeq: number };
type ScriptDrawerEntry = { key: number; scriptId: string; version: number | null; bulkRunId: string | null; width: number; openSeq: number };
type AutomationRuleDrawerEntry = { key: number; ruleId: string | null; width: number };
type ChannelDrawerEntry = { key: number; channelId: string | null; width: number };

// Every open call pushes a brand new stacked drawer instance (keyed by a fresh sequence number),
// even if a drawer for the same tunnel/script id is already open - reusing an existing instance
// silently discards its scroll position/expanded state, which loses context while tracing issues.
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [tunnelDrawers, setTunnelDrawers] = useState<TunnelDrawerEntry[]>([]);
  const [scriptDrawers, setScriptDrawers] = useState<ScriptDrawerEntry[]>([]);
  const [automationRuleDrawers, setAutomationRuleDrawers] = useState<AutomationRuleDrawerEntry[]>([]);
  const [channelDrawers, setChannelDrawers] = useState<ChannelDrawerEntry[]>([]);
  const openSeq = useRef(0);

  const api = useMemo(() => ({
    openTunnelDrawer: (tunnelId: string, tab: TunnelDrawerTab = "overall", enrollmentId?: string) => {
      openSeq.current += 1;
      const seq = openSeq.current;
      setTunnelDrawers((current) => [...current, { key: seq, tunnelId, tab, enrollmentId, width: DRAWER_DEFAULT_WIDTH, openSeq: seq }]);
    },
    openScriptDrawer: (scriptId: string, version: number | null = null, options?: { bulkRunId?: string | undefined }) => {
      openSeq.current += 1;
      const seq = openSeq.current;
      setScriptDrawers((current) => [
        ...current,
        { key: seq, scriptId, version, bulkRunId: options?.bulkRunId ?? null, width: DRAWER_DEFAULT_WIDTH, openSeq: seq }
      ]);
    },
    openAutomationRuleDrawer: (ruleId: string | null) => {
      openSeq.current += 1;
      const seq = openSeq.current;
      setAutomationRuleDrawers((current) => [...current, { key: seq, ruleId, width: DRAWER_DEFAULT_WIDTH }]);
    },
    openChannelDrawer: (channelId: string | null) => {
      openSeq.current += 1;
      const seq = openSeq.current;
      setChannelDrawers((current) => [...current, { key: seq, channelId, width: DRAWER_DEFAULT_WIDTH }]);
    }
  }), []);

  return (
    <DrawerContext.Provider value={api}>
      {children}
      <DrawerStackProvider>
        {tunnelDrawers.map((entry) => (
          <TunnelDrawer
            key={entry.key}
            tunnelId={entry.tunnelId}
            tab={entry.tab}
            initialExpandEnrollmentId={entry.enrollmentId ?? null}
            openSeq={entry.openSeq}
            onTabChange={(tab) => setTunnelDrawers((current) => current.map((item) => (item.key === entry.key ? { ...item, tab } : item)))}
            onClose={() => setTunnelDrawers((current) => current.filter((item) => item.key !== entry.key))}
            width={entry.width}
            onResize={(width) => setTunnelDrawers((current) => current.map((item) => (item.key === entry.key ? { ...item, width } : item)))}
          />
        ))}
        <Suspense fallback={null}>
          {scriptDrawers.map((entry) => (
            <ScriptDrawer
              key={entry.key}
              scriptId={entry.scriptId}
              version={entry.version}
              initialBulkRunId={entry.bulkRunId}
              openSeq={entry.openSeq}
              onClose={() => setScriptDrawers((current) => current.filter((item) => item.key !== entry.key))}
              width={entry.width}
              onResize={(width) => setScriptDrawers((current) => current.map((item) => (item.key === entry.key ? { ...item, width } : item)))}
            />
          ))}
          {automationRuleDrawers.map((entry) => (
            <AutomationRuleDrawer
              key={entry.key}
              ruleId={entry.ruleId}
              onClose={() => setAutomationRuleDrawers((current) => current.filter((item) => item.key !== entry.key))}
              width={entry.width}
              onResize={(width) => setAutomationRuleDrawers((current) => current.map((item) => (item.key === entry.key ? { ...item, width } : item)))}
            />
          ))}
          {channelDrawers.map((entry) => (
            <ChannelDrawer
              key={entry.key}
              channelId={entry.channelId}
              onClose={() => setChannelDrawers((current) => current.filter((item) => item.key !== entry.key))}
              width={entry.width}
              onResize={(width) => setChannelDrawers((current) => current.map((item) => (item.key === entry.key ? { ...item, width } : item)))}
            />
          ))}
        </Suspense>
      </DrawerStackProvider>
    </DrawerContext.Provider>
  );
}
