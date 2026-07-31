import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Layers3, Play, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { emptyExecutionStats, type AppSettings, type ArgumentBindings, type BulkScriptRun, type ExecutionStats, type ExecutionVariables, type ManagedScript, type ScriptArgument, type ScriptCommandExecution, type Tunnel } from "../types";
import { useDrawers } from "./DrawerContext";
import { ArgumentBindingsEditor, missingRequiredArgumentNames, ScriptArgumentsEditor } from "./ExecutionVariablesEditor";
import { ExecutionLog } from "./ExecutionLog";
import { ExecutionStatsSummary } from "./ExecutionStatsSummary";
import { FieldHelp } from "./FieldHelp";
import { HostPlatformIcon } from "./HostPlatformIcon";
import { Modal } from "./Modal";
import { ScriptEditor } from "./ScriptEditor";
import { SearchableSelect } from "./SearchableSelect";
import { SideDrawer } from "./SideDrawer";
import { StatusBadge } from "./StatusBadge";

type ScriptExecutionHistoryItem =
  | { kind: "execution"; execution: ScriptCommandExecution }
  | { kind: "bulk"; run: BulkScriptRun };

type ScriptExecutionHistoryPage = {
  scriptId: string;
  version: number | null;
  history: ScriptExecutionHistoryItem[];
  summary: ExecutionStats;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export function ScriptDrawer({ scriptId, version, initialBulkRunId, onClose, zIndex }: { scriptId: string | null; version: number | null; initialBulkRunId?: string | null; onClose: () => void; zIndex?: number | undefined }) {
  const queryClient = useQueryClient();
  const { openTunnelDrawer } = useDrawers();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [description, setDescription] = useState("");
  const [defaultTimeoutSeconds, setDefaultTimeoutSeconds] = useState(60);
  const [content, setContent] = useState("");
  const [argumentsList, setArgumentsList] = useState<ScriptArgument[]>([]);
  const [originalArguments, setOriginalArguments] = useState<ScriptArgument[]>([]);
  const [originalContent, setOriginalContent] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [executionPage, setExecutionPage] = useState(1);
  const [executionSearch, setExecutionSearch] = useState("");
  const [executionFrom, setExecutionFrom] = useState("");
  const [executionTo, setExecutionTo] = useState("");
  const [expandedExecutionId, setExpandedExecutionId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkName, setBulkName] = useState("");
  const [bulkDescription, setBulkDescription] = useState("");
  const [bulkTimeoutSeconds, setBulkTimeoutSeconds] = useState(60);
  const [bulkNameFilter, setBulkNameFilter] = useState("");
  const [bulkTenantCode, setBulkTenantCode] = useState("");
  const [bulkCfTunnelStatus, setBulkCfTunnelStatus] = useState("");
  const [bulkEnrollmentStatus, setBulkEnrollmentStatus] = useState("");
  const [bulkTunnelPage, setBulkTunnelPage] = useState(1);
  const [bulkSelectAll, setBulkSelectAll] = useState(false);
  const [bulkSelectedTunnels, setBulkSelectedTunnels] = useState<Record<string, Tunnel>>({});
  const [bulkExcludedTunnels, setBulkExcludedTunnels] = useState<Record<string, Tunnel>>({});
  const [bulkLeftChecked, setBulkLeftChecked] = useState<string[]>([]);
  const [bulkRightChecked, setBulkRightChecked] = useState<string[]>([]);
  const [bulkRightPage, setBulkRightPage] = useState(1);
  const [bulkFilterAppliesToSelected, setBulkFilterAppliesToSelected] = useState(false);
  const [bulkArgumentBindings, setBulkArgumentBindings] = useState<ArgumentBindings>({});
  const [bulkDetailRun, setBulkDetailRun] = useState<BulkScriptRun | null>(null);
  const [bulkDetailPage, setBulkDetailPage] = useState(1);
  const [bulkDetailStatus, setBulkDetailStatus] = useState("");
  const [bulkDetailTunnelSearch, setBulkDetailTunnelSearch] = useState("");
  const [expandedBulkExecutionId, setExpandedBulkExecutionId] = useState<string | null>(null);
  const deferredExecutionSearch = useDeferredValue(executionSearch.trim());
  const deferredBulkDetailTunnelSearch = useDeferredValue(bulkDetailTunnelSearch.trim());
  const handledInitialBulkRunId = useRef<string | null>(null);
  const { data: initialBulkDetailData } = useQuery({
    queryKey: ["bulk-script-execution-deep-link", scriptId, initialBulkRunId],
    queryFn: () => api.get<{ run: Omit<BulkScriptRun, keyof ExecutionStats | "selectedCount">; summary: ExecutionStats }>(`/api/scripts/${scriptId}/bulk-executions/${initialBulkRunId}?page=1&pageSize=10`),
    enabled: Boolean(scriptId && initialBulkRunId && handledInitialBulkRunId.current !== initialBulkRunId)
  });

  const { data: detailData } = useQuery({
    queryKey: ["script-detail", scriptId],
    queryFn: () => api.get<{ script: ManagedScript }>(`/api/scripts/${scriptId}`),
    enabled: Boolean(scriptId)
  });
  const detail = detailData?.script;
  const selectedVersionData = useMemo(() => detail?.versions.find((entry) => entry.version === selectedVersion) ?? detail?.versions[0], [detail, selectedVersion]);
  const bulkListPageSize = 5;
  const bulkFilterParams = new URLSearchParams({ page: String(bulkTunnelPage), pageSize: String(bulkListPageSize) });
  if (bulkNameFilter) bulkFilterParams.set("name", bulkNameFilter);
  if (bulkTenantCode) bulkFilterParams.set("tenantCode", bulkTenantCode);
  if (bulkCfTunnelStatus) bulkFilterParams.set("cfTunnelStatus", bulkCfTunnelStatus);
  if (bulkEnrollmentStatus) bulkFilterParams.set("enrollmentStatus", bulkEnrollmentStatus);
  if (detail?.platform) bulkFilterParams.set("activeEnrollmentPlatform", detail.platform);
  const { data: bulkTunnelData } = useQuery({
    queryKey: ["bulk-tunnel-matches", bulkNameFilter, bulkTenantCode, bulkCfTunnelStatus, bulkEnrollmentStatus, detail?.platform, bulkTunnelPage],
    queryFn: () => api.get<{ tunnels: Tunnel[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/api/tunnels?${bulkFilterParams}`),
    enabled: bulkOpen
  });
  const { data: bulkTenantCodesData } = useQuery({
    queryKey: ["tenant-codes"],
    queryFn: () => api.get<{ tenantCodes: string[] }>("/api/tunnels/tenant-codes"),
    enabled: bulkOpen
  });
  const { data: bulkSettingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: AppSettings }>("/api/settings"),
    enabled: bulkOpen
  });
  const bulkTenantCodeOptions = useMemo(() => [{ value: "", label: "Any tenant" }, ...(bulkTenantCodesData?.tenantCodes ?? []).map((code) => ({ value: code, label: code }))], [bulkTenantCodesData]);
  const bulkDetailPageSize = 10;
  const { data: bulkDetailData } = useQuery({
    queryKey: ["bulk-script-execution-detail", scriptId, bulkDetailRun?.id, bulkDetailStatus, deferredBulkDetailTunnelSearch, bulkDetailPage, bulkDetailPageSize],
    queryFn: () => api.get<{ run: BulkScriptRun; summary: ExecutionStats; executions: ScriptCommandExecution[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/api/scripts/${scriptId}/bulk-executions/${bulkDetailRun!.id}?page=${bulkDetailPage}&pageSize=${bulkDetailPageSize}${bulkDetailStatus ? `&status=${bulkDetailStatus}` : ""}${deferredBulkDetailTunnelSearch ? `&tunnelSearch=${encodeURIComponent(deferredBulkDetailTunnelSearch)}` : ""}`),
    enabled: Boolean(scriptId && bulkDetailRun),
    refetchInterval: (query) => query.state.data?.summary && (query.state.data.summary.scheduled > 0 || query.state.data.summary.running > 0) ? 2000 : false
  });
  const executionPageSize = 10;
  const executionParams = new URLSearchParams({ version: String(selectedVersion), page: String(executionPage), pageSize: String(executionPageSize) });
  if (deferredExecutionSearch) executionParams.set("search", deferredExecutionSearch);
  if (executionFrom) executionParams.set("from", new Date(executionFrom).toISOString());
  if (executionTo) executionParams.set("to", new Date(executionTo).toISOString());
  const { data: executionData, isFetching: executionsFetching } = useQuery({
    queryKey: ["script-execution-history", scriptId, selectedVersion, deferredExecutionSearch, executionFrom, executionTo, executionPage, executionPageSize],
    queryFn: () => api.get<ScriptExecutionHistoryPage>(`/api/scripts/${scriptId}/execution-history?${executionParams.toString()}`),
    enabled: Boolean(scriptId && selectedVersion),
    refetchInterval: (query) => query.state.data && (query.state.data.summary.scheduled > 0 || query.state.data.summary.running > 0 || query.state.data.history.some((item) => item.kind === "execution"
      ? ["scheduled", "running"].includes(item.execution.status)
      : item.run.scheduled > 0 || item.run.running > 0)) ? 2000 : false
  });

  useEffect(() => {
    setExecutionPage(1);
    setExpandedExecutionId(null);
  }, [scriptId, selectedVersion, deferredExecutionSearch, executionFrom, executionTo]);
  useEffect(() => {
    setBulkTunnelPage(1);
    setBulkLeftChecked([]);
    setBulkRightPage(1);
  }, [bulkNameFilter, bulkTenantCode, bulkCfTunnelStatus, bulkEnrollmentStatus]);
  useEffect(() => {
    setBulkRightPage(1);
    setBulkRightChecked([]);
  }, [bulkFilterAppliesToSelected]);
  useEffect(() => {
    if (!initialBulkRunId) {
      handledInitialBulkRunId.current = null;
      return;
    }
    if (!initialBulkDetailData || handledInitialBulkRunId.current === initialBulkRunId) return;
    handledInitialBulkRunId.current = initialBulkRunId;
    setBulkDetailRun({ ...initialBulkDetailData.run, selectedCount: initialBulkDetailData.summary.total, ...initialBulkDetailData.summary });
    setBulkDetailStatus("");
    setBulkDetailTunnelSearch("");
    setBulkDetailPage(1);
  }, [initialBulkDetailData, initialBulkRunId]);
  useEffect(() => { setBulkDetailPage(1); setExpandedBulkExecutionId(null); }, [bulkDetailRun?.id, bulkDetailStatus, deferredBulkDetailTunnelSearch]);
  useEffect(() => { setExpandedBulkExecutionId(null); }, [bulkDetailPage]);
  useEffect(() => {
    if (bulkDetailData?.pagination && bulkDetailPage > bulkDetailData.pagination.totalPages) setBulkDetailPage(bulkDetailData.pagination.totalPages);
  }, [bulkDetailData?.pagination, bulkDetailPage]);

  useEffect(() => {
    if (!detail) return;
    const requestedVersion = Number.isInteger(version) ? detail.versions.find((entry) => entry.version === version) : undefined;
    const initialVersion = requestedVersion ?? detail.versions[0];
    setName(detail.name);
    setLanguage(detail.language);
    setDescription(detail.description);
    setDefaultTimeoutSeconds(Math.round(detail.defaultTimeoutMs / 1000));
    setSelectedVersion(initialVersion?.version ?? null);
    setContent(initialVersion?.content ?? "");
    setOriginalContent(initialVersion?.content ?? "");
    setArgumentsList(initialVersion?.arguments ?? []);
    setOriginalArguments(initialVersion?.arguments ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id]);

  useEffect(() => {
    if (selectedVersionData) {
      setContent(selectedVersionData.content);
      setOriginalContent(selectedVersionData.content);
      // Arguments are pinned to the version, so selecting one shows the
      // definition that version's runs were prepared against.
      setArgumentsList(selectedVersionData.arguments);
      setOriginalArguments(selectedVersionData.arguments);
    }
  }, [selectedVersionData]);

  const argumentsChanged = JSON.stringify(argumentsList) !== JSON.stringify(originalArguments);
  const save = useMutation({
    mutationFn: async () => {
      if (!scriptId) throw new Error("No script selected");
      await api.patch(`/api/scripts/${scriptId}`, { name, language, description, defaultTimeoutMs: defaultTimeoutSeconds * 1000 });
      // A version is immutable, so a changed argument definition creates a new
      // one exactly like changed content does.
      if (content !== originalContent || argumentsChanged) {
        return api.post<{ id: string; version: number }>(`/api/scripts/${scriptId}/versions`, { content, arguments: argumentsList });
      }
      return null;
    },
    onSuccess: async (created) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["script-detail", scriptId] })
      ]);
      if (created) {
        setSelectedVersion(created.version);
        toast.success("Script version saved");
      } else {
        toast.success("Script details saved");
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save script")
  });
  const deleteScript = useMutation({
    mutationFn: () => api.delete<{ success: boolean; scriptId: string; scriptName: string; deletedExecutionCount: number }>(`/api/scripts/${scriptId}`),
    onSuccess: async (result) => {
      setDeleteOpen(false);
      queryClient.removeQueries({ queryKey: ["script-detail", result.scriptId] });
      queryClient.removeQueries({ queryKey: ["script-execution-history", result.scriptId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail"] })
      ]);
      toast.success(`${result.scriptName} deleted with ${result.deletedExecutionCount} execution record${result.deletedExecutionCount === 1 ? "" : "s"}`);
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete script")
  });
  const refreshExecutions = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: ["script-execution-history", scriptId, selectedVersion], type: "active" }),
    onError: () => toast.error("Unable to refresh script execution history")
  });

  const executionHistory = executionData?.history ?? [];
  const executionPagination = executionData?.pagination;
  const executionSummary = executionData?.summary ?? emptyExecutionStats;
  const bulkExecute = useMutation({
    mutationFn: () => api.post<{ bulkExecutionId: string }>(`/api/scripts/${scriptId}/bulk-execute`, {
      scriptVersionId: selectedVersionData?.id,
      name: bulkName,
      description: bulkDescription,
      filters: { name: bulkNameFilter || undefined, tenantCode: bulkTenantCode || undefined, cfTunnelStatus: bulkCfTunnelStatus || undefined, enrollmentStatus: bulkEnrollmentStatus || undefined },
      selectAll: bulkSelectAll,
      timeoutMs: bulkTimeoutSeconds * 1000,
      argumentBindings: bulkArgumentBindings,
      ...(bulkSelectAll ? { excludeTunnelIds: Object.keys(bulkExcludedTunnels) } : { tunnelIds: Object.keys(bulkSelectedTunnels) })
    }),
    onSuccess: async () => {
      setBulkOpen(false);
      setExecutionPage(1);
      await queryClient.invalidateQueries({ queryKey: ["script-execution-history", scriptId] });
      toast.success("Bulk execution started");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to start bulk execution")
  });
  const bulkSelectedList = useMemo(() => Object.values(bulkSelectedTunnels).sort((left, right) => left.displayName.localeCompare(right.displayName)), [bulkSelectedTunnels]);
  // A single "available variables" list can't be authoritative across many
  // tunnels - account/zone/tunnel-scoped values can differ per target. This is
  // a best-effort union (global settings + built-ins + whatever the
  // currently-visible matched/selected tunnels themselves define) to populate
  // the variable picker; the actual value used for a "variable" binding is
  // still resolved fresh per tunnel at execution time.
  const bulkAvailableVariables = useMemo(() => {
    const merged: ExecutionVariables = { ...(bulkSettingsData?.settings.executionVariables ?? {}) };
    for (const tunnel of [...(bulkTunnelData?.tunnels ?? []), ...bulkSelectedList]) Object.assign(merged, tunnel.executionVariables ?? {});
    for (const name of ["TENANT_CODE", "TUNNEL_NAME", "TUNNEL_CODE"]) merged[name] ??= "";
    return merged;
  }, [bulkSettingsData, bulkTunnelData, bulkSelectedList]);
  // Global values are the same everywhere, so they're safe to preview
  // literally. Everything else (built-ins, and any tunnel's own variables)
  // came from one specific tunnel and isn't representative of the whole
  // selection, so its preview should say so instead of showing that one
  // sampled value as if it applied to every target.
  const bulkVariesPerTunnelNames = useMemo(
    () => Object.keys(bulkAvailableVariables).filter((name) => !(name in (bulkSettingsData?.settings.executionVariables ?? {}))),
    [bulkAvailableVariables, bulkSettingsData]
  );
  const matchesBulkFilter = (tunnel: Tunnel) =>
    (!bulkNameFilter.trim() || tunnel.displayName.toLowerCase().includes(bulkNameFilter.trim().toLowerCase()) || tunnel.tunnelCode.toLowerCase().includes(bulkNameFilter.trim().toLowerCase()))
    && (!bulkTenantCode.trim() || tunnel.tenantCode.toLowerCase().includes(bulkTenantCode.trim().toLowerCase()))
    && (!bulkCfTunnelStatus || tunnel.cfTunnelStatus === bulkCfTunnelStatus)
    && (!bulkEnrollmentStatus || tunnel.onboardingStatus === bulkEnrollmentStatus)
    && (!detail?.platform || tunnel.activeEnrollmentPlatform === detail.platform);
  const bulkSelectedVisibleList = bulkFilterAppliesToSelected ? bulkSelectedList.filter(matchesBulkFilter) : bulkSelectedList;
  const bulkExcludedMatchingCount = Object.values(bulkExcludedTunnels).filter(matchesBulkFilter).length;
  const bulkSelectAllCount = Math.max(0, (bulkTunnelData?.pagination.total ?? 0) - bulkExcludedMatchingCount);
  const bulkLeftMatchedCount = bulkSelectAll ? bulkExcludedMatchingCount : Math.max(0, (bulkTunnelData?.pagination.total ?? 0) - bulkSelectedList.filter(matchesBulkFilter).length);
  const bulkRightPageCount = Math.max(1, Math.ceil(bulkSelectedVisibleList.length / bulkListPageSize));
  const bulkRightPageItems = bulkSelectedVisibleList.slice((bulkRightPage - 1) * bulkListPageSize, bulkRightPage * bulkListPageSize);
  useEffect(() => {
    if (bulkRightPage > bulkRightPageCount) setBulkRightPage(bulkRightPageCount);
  }, [bulkRightPage, bulkRightPageCount]);
  const addBulkChecked = () => {
    if (bulkSelectAll) {
      setBulkExcludedTunnels((current) => {
        const next = { ...current };
        for (const id of bulkLeftChecked) delete next[id];
        return next;
      });
    } else {
      setBulkSelectedTunnels((current) => {
        const next = { ...current };
        for (const tunnel of bulkTunnelData?.tunnels ?? []) if (bulkLeftChecked.includes(tunnel.id)) next[tunnel.id] = tunnel;
        return next;
      });
    }
    setBulkLeftChecked([]);
  };
  const addAllBulkMatched = () => {
    setBulkSelectAll(true);
    setBulkSelectedTunnels({});
    setBulkExcludedTunnels({});
    setBulkLeftChecked([]);
    setBulkRightChecked([]);
    setBulkRightPage(1);
  };
  const removeBulkChecked = () => {
    if (bulkSelectAll) {
      setBulkExcludedTunnels((current) => {
        const next = { ...current };
        for (const tunnel of bulkTunnelData?.tunnels ?? []) if (bulkRightChecked.includes(tunnel.id)) next[tunnel.id] = tunnel;
        return next;
      });
    } else {
      setBulkSelectedTunnels((current) => {
        const next = { ...current };
        for (const id of bulkRightChecked) delete next[id];
        return next;
      });
    }
    setBulkRightChecked([]);
  };
  const removeAllBulkSelected = () => {
    setBulkSelectAll(false);
    setBulkSelectedTunnels({});
    setBulkExcludedTunnels({});
    setBulkRightChecked([]);
    setBulkLeftChecked([]);
    setBulkRightPage(1);
  };

  return <>
    <SideDrawer open={Boolean(scriptId) && !initialBulkRunId} zIndex={zIndex} title={<div className="drawer-heading">{detail ? <HostPlatformIcon platform={detail.platform} size={18} /> : null}<strong>{detail?.name ?? "Script details"}</strong></div>} onClose={onClose}>
      {detail && <div className="tunnel-drawer-tab">
        <div className="script-metadata-grid">
          <label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown when an operator selects a script for a tunnel. Names must be unique within the same platform." /></span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span className="field-label">Platform</span><select value={detail.platform} disabled><option value="windows">Windows</option><option value="unix">Unix</option></select></label>
          <label className="field"><span className="field-label">Language <FieldHelp text="Controls syntax highlighting and identifies the shell expected on the enrolled host." /></span><select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>{detail.platform === "windows" ? <option value="powershell">PowerShell</option> : <><option value="bash">Bash</option><option value="sh">POSIX sh</option></>}</select></label>
          <label className="field"><span className="field-label">Description <FieldHelp text="Optional operator-facing context about the script's purpose, prerequisites, or expected effect." /></span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional description" /></label>
        </div>
        {detail.versions.length > 0 && <section className="script-version-history">
          <div className="script-version-timeline">{detail.versions.map((entry) => <button key={entry.id} type="button" title={`Version ${entry.version} · ${entry.createdBy ?? "system"} · ${new Date(entry.createdAt).toLocaleString()}`} className={`script-version-item ${entry.version === selectedVersion ? "active" : ""}`} onClick={() => setSelectedVersion(entry.version)}>
            <span className="script-version-dot" />
            <span className="script-version-meta">
              <strong>Version {entry.version}{entry.version === detail.latestVersion && <span className="script-version-latest-tag">Latest</span>}</strong>
              <span>{entry.createdBy ?? "system"} · {new Date(entry.createdAt).toLocaleString()}</span>
            </span>
          </button>)}</div>
        </section>}
        <ScriptEditor value={content} language={language} readOnly={selectedVersionData?.version !== detail.latestVersion} onChange={setContent} />
        <ScriptArgumentsEditor argumentsList={argumentsList} onChange={setArgumentsList} />
        <div className="script-editor-hint-row"><span className="script-editor-hint">{content !== originalContent ? `Creates version ${(detail.latestVersion ?? 0) + 1}` : "No content changes"}</span></div>
        <div className="form-actions script-editor-actions"><div className="critical-actions"><button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => setDeleteOpen(true)}><Trash2 size={15} />Delete script</button><button className="button button-danger" type="button" onClick={() => { setBulkName(`${name} bulk`); setBulkDescription(""); setBulkTimeoutSeconds(defaultTimeoutSeconds); setBulkNameFilter(""); setBulkTenantCode(""); setBulkCfTunnelStatus("healthy"); setBulkEnrollmentStatus("active"); setBulkTunnelPage(1); setBulkSelectAll(false); setBulkSelectedTunnels({}); setBulkLeftChecked([]); setBulkRightChecked([]); setBulkRightPage(1); setBulkFilterAppliesToSelected(false); setBulkArgumentBindings({}); setBulkOpen(true); }}><Layers3 size={15} />Bulk execute</button></div><label className="script-save-timeout"><span className="script-editor-hint">Default timeout (seconds)</span><input type="number" min={1} max={300} value={defaultTimeoutSeconds} onChange={(event) => setDefaultTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label><button className="button button-primary" type="button" disabled={!name.trim() || !content.trim() || save.isPending || deleteScript.isPending} onClick={() => save.mutate()}><Save size={15} />{save.isPending ? "Saving..." : "Save changes"}</button></div>
        {selectedVersion && <section className="script-execution-history"><header><div><h3>Execution history</h3><span>Version {selectedVersion}</span></div><div className="command-history-head-actions"><ExecutionStatsSummary stats={executionSummary} /><span>{executionPagination?.total ?? 0} run{executionPagination?.total === 1 ? "" : "s"}</span><button className="icon-button" type="button" title="Refresh execution history" aria-label="Refresh execution history" disabled={refreshExecutions.isPending || executionsFetching} onClick={() => refreshExecutions.mutate()}><RefreshCw size={14} className={refreshExecutions.isPending || executionsFetching ? "spin-icon" : undefined} /></button></div></header><div className="execution-history-filters"><label className="execution-history-search"><Search size={14} /><input type="search" value={executionSearch} onChange={(event) => setExecutionSearch(event.target.value)} placeholder="Search script, description, tunnel, tenant, or code" aria-label="Search script execution history" /></label><label><span>From</span><input type="datetime-local" step="60" value={executionFrom} onChange={(event) => setExecutionFrom(event.target.value)} aria-label="Filter script execution history from time" /></label><label><span>To</span><input type="datetime-local" step="60" value={executionTo} onChange={(event) => setExecutionTo(event.target.value)} aria-label="Filter script execution history to time" /></label></div>{executionHistory.length ? <div className="script-execution-list">{executionHistory.map((item) => {
          if (item.kind === "bulk") {
            const run = item.run;
            const active = run.scheduled > 0 || run.running > 0;
            const itemId = `bulk:${run.id}`;
            const isExpanded = expandedExecutionId === itemId;
            const runStats = { total: run.selectedCount, scheduled: run.scheduled, running: run.running, succeeded: run.succeeded, failed: run.failed, timedOut: run.timedOut, cancelled: run.cancelled };
            return <details className={`command-execution command-execution-${active ? "running" : "succeeded"}`} key={itemId} open={isExpanded} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(itemId); else if (isExpanded) setExpandedExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={active ? "running" : "succeeded"} label={active ? "Running" : "Complete"} /><span className="command-execution-source-tag">bulk</span><strong className="command-execution-inline-name">{run.name}</strong>{!isExpanded && <ExecutionStatsSummary compact stats={runStats} />}</span><span className="command-execution-timing"><time>{new Date(run.createdAt).toLocaleString()}</time><code>{active ? `${run.scheduled + run.running} active` : `${run.selectedCount} complete`}</code></span></summary>{isExpanded && <div className="bulk-run-group-body"><p>{run.description || "No description"}</p><div className="bulk-run-stats-row"><ExecutionStatsSummary stats={runStats} /><button className="button button-secondary button-small" type="button" onClick={() => { setBulkDetailRun(run); setBulkDetailStatus(""); setBulkDetailTunnelSearch(""); setBulkDetailPage(1); }}><Layers3 size={14} />Open bulk run details</button></div></div>}</details>;
          }
          const execution = item.execution;
          const itemId = `execution:${execution.id}`;
          const statusLabel = execution.status === "succeeded" ? "Succeeded" : execution.status === "failed" ? "Error" : execution.status === "timed_out" ? "Timeout" : execution.status === "cancelled" ? "Cancelled" : execution.status === "scheduled" ? "Scheduled" : execution.status === "never_run" ? "Never run" : "Running";
          const environment = scriptExecutionEnvironment(execution);
          const executionTime = execution.startedAt ?? execution.createdAt;
          return <details className={`command-execution command-execution-${execution.status}`} key={itemId} open={expandedExecutionId === itemId} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(itemId); else if (expandedExecutionId === itemId) setExpandedExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={execution.status} label={statusLabel} /><button className="script-execution-tunnel-link" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openTunnelDrawer(execution.tunnelId, "connect"); }}>{execution.tunnelDisplayName}</button><code className="command-execution-tunnel-code">{execution.tenantCode} / {execution.tunnelCode}</code><span className="host-identity" title={environment}><HostPlatformIcon environment={execution.environment} platform={execution.enrollmentPlatform} osName={execution.osName} /><code>{execution.computerName ?? "N/A"}</code></span></span><span className="command-execution-timing"><time>{new Date(executionTime).toLocaleString()}</time><code>{execution.elapsedMs !== null ? `${execution.elapsedMs} ms` : execution.status}</code></span></summary>{expandedExecutionId === itemId && <div className="command-execution-body"><ExecutionLog tunnelId={execution.tunnelId} execution={execution} /></div>}</details>;
        })}</div> : <div className="quiet-empty">This script version has not been executed.</div>}{executionPagination && executionPagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous execution page" aria-label="Previous execution page" disabled={executionPagination.page <= 1} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => Math.max(1, page - 1)); }}><ChevronLeft size={15} /></button><span>Page {executionPagination.page} of {executionPagination.totalPages}</span><button className="icon-button" type="button" title="Next execution page" aria-label="Next execution page" disabled={executionPagination.page >= executionPagination.totalPages} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => page + 1); }}><ChevronRight size={15} /></button></div>}</section>}
      </div>}
    </SideDrawer>
    <Modal open={deleteOpen} title={`Delete script · ${name}`} onClose={() => setDeleteOpen(false)}><div className="delete-confirmation"><div className="inline-alert"><AlertTriangle size={15} />This permanently deletes the saved script, every version, and all related execution history. This action cannot be undone.</div><div className="form-actions"><button className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => deleteScript.mutate()}><Trash2 size={15} />{deleteScript.isPending ? "Deleting..." : "Delete permanently"}</button></div></div></Modal>
    <Modal open={bulkOpen} title={`Bulk execute · ${name}`} onClose={() => setBulkOpen(false)} width="extra-wide">
      <div className="bulk-execute-form">
        <div className="bulk-run-metadata-grid"><label className="field"><span className="field-label">Run name</span><input value={bulkName} maxLength={120} onChange={(event) => setBulkName(event.target.value)} /></label><label className="field"><span className="field-label">Description</span><input value={bulkDescription} maxLength={1000} onChange={(event) => setBulkDescription(event.target.value)} placeholder="Change ticket, purpose, or rollout context" /></label></div>
        <section className="bulk-filter-bar">
          <div className="bulk-filter-grid"><label className="field"><span className="field-label">Name</span><input value={bulkNameFilter} onChange={(event) => setBulkNameFilter(event.target.value)} placeholder="Tunnel name or code" /></label><label className="field"><span className="field-label">Tenant code</span><SearchableSelect name="bulkTenantCode" options={bulkTenantCodeOptions} value={bulkTenantCode} ariaLabel="Filter by tenant code" emptyMessage="No matching tenant" onValueChange={setBulkTenantCode} /></label><label className="field"><span className="field-label">Connectivity status</span><select value={bulkCfTunnelStatus} onChange={(event) => setBulkCfTunnelStatus(event.target.value)}><option value="">Any connectivity status</option><option value="not_created">Not created</option><option value="inactive">Inactive</option><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="down">Down</option><option value="unknown">Unknown</option></select></label><label className="field"><span className="field-label">Enrollment status</span><select value={bulkEnrollmentStatus} onChange={(event) => setBulkEnrollmentStatus(event.target.value)}><option value="">Any enrollment status</option><option value="active">Active</option><option value="waiting_for_new_enrollment">Waiting for new enrollment</option><option value="url_issued">URL issued</option><option value="claimed">Claimed</option><option value="provisioning">Provisioning</option><option value="expired">Expired</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select></label></div>
          <label className="bulk-filter-apply-selected"><input type="checkbox" checked={bulkFilterAppliesToSelected} onChange={(event) => setBulkFilterAppliesToSelected(event.target.checked)} />Also apply for selected</label>
        </section>
        <div className="bulk-transfer-layout">
          <section className="bulk-transfer-panel">
            <header className="bulk-transfer-panel-header"><h3>Matched tunnels</h3><span>The filter above is just a helper to find tunnels — use Add or Add all to build the run. Only tunnels currently enrolled on {detail?.platform === "windows" ? "Windows" : "Unix/Linux/macOS"} are shown, since that's what this script runs on.</span></header>
            <div className="bulk-tunnel-list">{(() => {
              const visibleTunnels = (bulkTunnelData?.tunnels ?? []).filter((tunnel) => bulkSelectAll ? Boolean(bulkExcludedTunnels[tunnel.id]) : !bulkSelectedTunnels[tunnel.id]);
              if (!bulkTunnelData) return null;
              if (!visibleTunnels.length) return <div className="bulk-tunnel-list-empty">{bulkTunnelData.tunnels.length ? "Every tunnel on this page is already selected." : "No tunnels match these filters."}</div>;
              return visibleTunnels.map((tunnel) => <label className="bulk-tunnel-list-row" key={tunnel.id}><input type="checkbox" checked={bulkLeftChecked.includes(tunnel.id)} aria-label={`Check ${tunnel.displayName} to add`} onChange={(event) => setBulkLeftChecked((current) => event.target.checked ? [...new Set([...current, tunnel.id])] : current.filter((id) => id !== tunnel.id))} /><span className="bulk-tunnel-list-info"><strong>{tunnel.displayName}</strong><code>{tunnel.tenantCode} / {tunnel.tunnelCode}</code></span><StatusBadge status={tunnel.onboardingStatus} /></label>);
            })()}</div>
            <div className="bulk-match-footer">
              <span className="bulk-match-footer-text"><strong>{bulkLeftMatchedCount} tunnel{bulkLeftMatchedCount === 1 ? "" : "s"} matched</strong></span>
              {bulkTunnelData && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous tunnel page" aria-label="Previous tunnel page" disabled={bulkTunnelPage <= 1} onClick={() => setBulkTunnelPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span>Page {bulkTunnelPage} of {bulkTunnelData.pagination.totalPages}</span><button className="icon-button" type="button" title="Next tunnel page" aria-label="Next tunnel page" disabled={bulkTunnelPage >= bulkTunnelData.pagination.totalPages} onClick={() => setBulkTunnelPage((page) => page + 1)}><ChevronRight size={15} /></button></div>}
            </div>
          </section>
          <div className="bulk-transfer-controls">
            <button type="button" className="button button-secondary" disabled={!bulkLeftChecked.length} onClick={addBulkChecked} title="Add checked tunnels"><ChevronRight size={15} />Add ({bulkLeftChecked.length})</button>
            <button type="button" className="button button-secondary" disabled={!bulkTunnelData?.pagination.total} onClick={addAllBulkMatched} title="Add all tunnels matching the current filter"><ChevronsRight size={15} />Add all</button>
            <button type="button" className="button button-secondary" disabled={!bulkRightChecked.length} onClick={removeBulkChecked} title="Remove checked tunnels"><ChevronLeft size={15} />Remove ({bulkRightChecked.length})</button>
            <button type="button" className="button button-secondary" disabled={!bulkSelectAll && !bulkSelectedList.length} onClick={removeAllBulkSelected} title="Remove every selected tunnel"><ChevronsLeft size={15} />Remove all</button>
          </div>
          <section className="bulk-transfer-panel">
            <header className="bulk-transfer-panel-header"><h3>Selected</h3><span>{bulkSelectAll ? "All tunnels matching the filter above will run, including tunnels on other pages" : "Tunnels picked from the filter on the left"}</span></header>
            {bulkSelectAll ? <>
              <div className="bulk-tunnel-list">{(() => {
                const includedTunnels = (bulkTunnelData?.tunnels ?? []).filter((tunnel) => !bulkExcludedTunnels[tunnel.id]);
                if (!bulkTunnelData) return null;
                if (!includedTunnels.length) return <div className="bulk-tunnel-list-empty">{bulkTunnelData.tunnels.length ? "Every tunnel on this page has been removed from the run." : "No tunnels match these filters."}</div>;
                return includedTunnels.map((tunnel) => <label className="bulk-tunnel-list-row bulk-tunnel-list-row-added" key={tunnel.id}><input type="checkbox" checked={bulkRightChecked.includes(tunnel.id)} aria-label={`Check ${tunnel.displayName} to remove`} onChange={(event) => setBulkRightChecked((current) => event.target.checked ? [...new Set([...current, tunnel.id])] : current.filter((id) => id !== tunnel.id))} /><span className="bulk-tunnel-list-info"><strong>{tunnel.displayName}</strong><code>{tunnel.tenantCode} / {tunnel.tunnelCode}</code></span><StatusBadge status={tunnel.onboardingStatus} /></label>);
              })()}</div>
              <div className="bulk-match-footer">
                <span className="bulk-match-footer-text"><strong>{bulkSelectAllCount} tunnel{bulkSelectAllCount === 1 ? "" : "s"} selected</strong></span>
                {bulkTunnelData && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous tunnel page" aria-label="Previous tunnel page" disabled={bulkTunnelPage <= 1} onClick={() => setBulkTunnelPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span>Page {bulkTunnelPage} of {bulkTunnelData.pagination.totalPages}</span><button className="icon-button" type="button" title="Next tunnel page" aria-label="Next tunnel page" disabled={bulkTunnelPage >= bulkTunnelData.pagination.totalPages} onClick={() => setBulkTunnelPage((page) => page + 1)}><ChevronRight size={15} /></button></div>}
              </div>
            </> : <>
              <div className="bulk-tunnel-list">{bulkRightPageItems.length ? bulkRightPageItems.map((tunnel) => <label className="bulk-tunnel-list-row" key={tunnel.id}><input type="checkbox" checked={bulkRightChecked.includes(tunnel.id)} aria-label={`Check ${tunnel.displayName} to remove`} onChange={(event) => setBulkRightChecked((current) => event.target.checked ? [...new Set([...current, tunnel.id])] : current.filter((id) => id !== tunnel.id))} /><span className="bulk-tunnel-list-info"><strong>{tunnel.displayName}</strong><code>{tunnel.tenantCode} / {tunnel.tunnelCode}</code></span><StatusBadge status={tunnel.onboardingStatus} /></label>) : <div className="bulk-tunnel-list-empty">{bulkFilterAppliesToSelected && bulkSelectedList.length ? "No selected tunnels match the current filter." : "No tunnels picked yet. Filter and Add tunnels from the left, or Add all."}</div>}</div>
              <div className="bulk-match-footer">
                <span className="bulk-match-footer-text"><strong>{bulkSelectedList.length} tunnel{bulkSelectedList.length === 1 ? "" : "s"} selected</strong></span>
                <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous selected page" aria-label="Previous selected page" disabled={bulkRightPage <= 1} onClick={() => setBulkRightPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span>Page {bulkRightPage} of {bulkRightPageCount}</span><button className="icon-button" type="button" title="Next selected page" aria-label="Next selected page" disabled={bulkRightPage >= bulkRightPageCount} onClick={() => setBulkRightPage((page) => page + 1)}><ChevronRight size={15} /></button></div>
              </div>
            </>}
          </section>
        </div>
        <ArgumentBindingsEditor argumentsList={argumentsList} bindings={bulkArgumentBindings} availableVariables={bulkAvailableVariables} variesPerTunnelNames={bulkVariesPerTunnelNames} onChange={setBulkArgumentBindings} />
        <div className="form-actions"><button className="button button-secondary bulk-cancel-button" type="button" onClick={() => setBulkOpen(false)}>Cancel</button><span>{bulkSelectAll ? `${bulkSelectAllCount} selected` : `${bulkSelectedList.length} selected`}</span><label className="field bulk-timeout-field"><span className="field-label">Timeout (s) <FieldHelp text="The maximum time the command agent may let each per-tunnel execution run before terminating it. Allowed range: 1 to 300 seconds." /></span><input type="number" min={1} max={300} value={bulkTimeoutSeconds} onChange={(event) => setBulkTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label><button className="button button-primary" type="button" disabled={!bulkName.trim() || !selectedVersionData || bulkExecute.isPending || (bulkSelectAll ? !bulkSelectAllCount : !bulkSelectedList.length) || Boolean(missingRequiredArgumentNames(argumentsList, bulkArgumentBindings, bulkAvailableVariables, bulkVariesPerTunnelNames).length)} onClick={() => bulkExecute.mutate()}><Play size={15} />{bulkExecute.isPending ? "Starting..." : "Execute selected"}</button></div>
      </div>
    </Modal>
    <SideDrawer open={Boolean(bulkDetailRun)} zIndex={(zIndex ?? 100) + 2} title={<div className="drawer-heading"><Layers3 size={18} /><strong>{bulkDetailRun?.name ?? "Bulk execution"}</strong></div>} onClose={() => { if (initialBulkRunId) onClose(); else setBulkDetailRun(null); }}>
      {bulkDetailRun && <div className="bulk-execution-detail"><header><div><p>{bulkDetailRun.description || "No description"}</p></div><time>{new Date(bulkDetailRun.createdAt).toLocaleString()}</time></header>{(() => {
        const previewVersion = detail?.versions.find((entry) => entry.id === bulkDetailRun.scriptVersionId) ?? selectedVersionData;
        const bindingEntries = Object.entries(bulkDetailRun.argumentBindings).sort(([left], [right]) => left.localeCompare(right));
        return previewVersion ? <div className="command-script-preview bulk-script-preview"><header><div><strong>Script preview</strong><span>{detail?.name ?? "Script"} · Version {previewVersion.version}</span></div><code>{detail?.language ?? ""}</code></header><ScriptEditor value={previewVersion.content} language={detail?.language ?? "powershell"} height="220px" readOnly /><details className="execution-applied-variables resolved-variables-preview" open><summary>Argument bindings for this run{bindingEntries.length ? ` (${bindingEntries.length})` : ""}</summary><div className="execution-applied-variable-list">{bindingEntries.length ? bindingEntries.map(([name, binding]) => <div className="execution-applied-variable-row" key={name}><code className="execution-applied-variable-name">{name}</code><code className="execution-applied-variable-value">{binding.type === "variable" ? `→ ${binding.variable}` : binding.value}</code></div>) : <div className="quiet-empty">No explicit bindings; every argument used its own declared default value.</div>}</div></details></div> : null;
      })()}<ExecutionStatsSummary stats={bulkDetailData?.summary ?? { total: bulkDetailRun.selectedCount, scheduled: bulkDetailRun.scheduled, running: bulkDetailRun.running, succeeded: bulkDetailRun.succeeded, failed: bulkDetailRun.failed, timedOut: bulkDetailRun.timedOut, cancelled: bulkDetailRun.cancelled }} />
        <div className="bulk-detail-filters"><select value={bulkDetailStatus} onChange={(event) => setBulkDetailStatus(event.target.value)} aria-label="Filter bulk executions by status"><option value="">All statuses</option><option value="scheduled">Scheduled</option><option value="running">Running</option><option value="succeeded">Succeeded</option><option value="failed">Error</option><option value="timed_out">Timeout</option><option value="cancelled">Cancelled</option></select><input type="search" value={bulkDetailTunnelSearch} onChange={(event) => setBulkDetailTunnelSearch(event.target.value)} aria-label="Filter bulk executions by tunnel name, tenant code, or tunnel code" placeholder="Filter tunnel name, tenant, or code" /></div>
        <div className="script-execution-list">{bulkDetailData?.executions.map((execution) => {
          const environment = scriptExecutionEnvironment(execution);
          const isOpen = expandedBulkExecutionId === execution.id;
          return <details className={`command-execution command-execution-${execution.status}`} key={execution.id} open={isOpen} onToggle={(event) => { if (event.currentTarget.open) setExpandedBulkExecutionId(execution.id); else if (expandedBulkExecutionId === execution.id) setExpandedBulkExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={execution.status} /><button className="script-execution-tunnel-link" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openTunnelDrawer(execution.tunnelId, "connect"); }}>{execution.tunnelDisplayName}</button><code className="command-execution-tunnel-code">{execution.tenantCode} / {execution.tunnelCode}</code><span className="host-identity" title={environment}><HostPlatformIcon environment={execution.environment} platform={execution.enrollmentPlatform} osName={execution.osName} /><code>{execution.computerName ?? "N/A"}</code></span></span><span className="command-execution-timing"><time>{new Date(execution.startedAt ?? execution.createdAt).toLocaleString()}</time><code>{execution.elapsedMs === null ? execution.status : `${execution.elapsedMs} ms`}</code></span></summary>{isOpen && <div className="command-execution-body"><ExecutionLog tunnelId={execution.tunnelId} execution={execution} /></div>}</details>;
        })}</div>{bulkDetailData && bulkDetailData.pagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous bulk execution log page" aria-label="Previous bulk execution log page" disabled={bulkDetailData.pagination.page <= 1} onClick={() => setBulkDetailPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span>Page {bulkDetailData.pagination.page} of {bulkDetailData.pagination.totalPages}</span><button className="icon-button" type="button" title="Next bulk execution log page" aria-label="Next bulk execution log page" disabled={bulkDetailData.pagination.page >= bulkDetailData.pagination.totalPages} onClick={() => setBulkDetailPage((page) => page + 1)}><ChevronRight size={15} /></button></div>}
      </div>}
    </SideDrawer>
  </>;
}

function scriptExecutionEnvironment(execution: ScriptCommandExecution): string {
  switch (execution.environment ?? execution.enrollmentPlatform) {
    case "windows": return "Windows";
    case "linux": return "Linux";
    case "darwin": return "macOS";
    case "unix": return "Unix";
    default: return "Not detected";
  }
}
