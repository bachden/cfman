import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, Layers3, Play, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { emptyExecutionStats, type BulkScriptRun, type ExecutionStats, type ManagedScript, type ScriptCommandExecution, type Store } from "../types";
import { useDrawers } from "./DrawerContext";
import { ExecutionLog } from "./ExecutionLog";
import { ExecutionStatsSummary } from "./ExecutionStatsSummary";
import { FieldHelp } from "./FieldHelp";
import { HostPlatformIcon } from "./HostPlatformIcon";
import { Modal } from "./Modal";
import { ScriptEditor } from "./ScriptEditor";
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
  const { openStoreDrawer } = useDrawers();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [description, setDescription] = useState("");
  const [defaultTimeoutSeconds, setDefaultTimeoutSeconds] = useState(60);
  const [content, setContent] = useState("");
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
  const [bulkTenantCode, setBulkTenantCode] = useState("");
  const [bulkTunnelStatus, setBulkTunnelStatus] = useState("");
  const [bulkEnrollmentStatus, setBulkEnrollmentStatus] = useState("");
  const [bulkStorePage, setBulkStorePage] = useState(1);
  const [bulkSelectAll, setBulkSelectAll] = useState(true);
  const [bulkSelectedStoreIds, setBulkSelectedStoreIds] = useState<string[]>([]);
  const [bulkDetailRun, setBulkDetailRun] = useState<BulkScriptRun | null>(null);
  const [bulkDetailPage, setBulkDetailPage] = useState(1);
  const [bulkDetailStatus, setBulkDetailStatus] = useState("");
  const [bulkDetailStoreSearch, setBulkDetailStoreSearch] = useState("");
  const [expandedBulkExecutionId, setExpandedBulkExecutionId] = useState<string | null>(null);
  const deferredExecutionSearch = useDeferredValue(executionSearch.trim());
  const deferredBulkDetailStoreSearch = useDeferredValue(bulkDetailStoreSearch.trim());
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
  const bulkStorePageSize = 10;
  const bulkFilterParams = new URLSearchParams({ page: String(bulkStorePage), pageSize: String(bulkStorePageSize) });
  if (bulkTenantCode) bulkFilterParams.set("tenantCode", bulkTenantCode);
  if (bulkTunnelStatus) bulkFilterParams.set("tunnelStatus", bulkTunnelStatus);
  if (bulkEnrollmentStatus) bulkFilterParams.set("enrollmentStatus", bulkEnrollmentStatus);
  const { data: bulkStoreData } = useQuery({
    queryKey: ["bulk-store-matches", bulkTenantCode, bulkTunnelStatus, bulkEnrollmentStatus, bulkStorePage],
    queryFn: () => api.get<{ stores: Store[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/api/stores?${bulkFilterParams}`),
    enabled: bulkOpen
  });
  const bulkDetailPageSize = 10;
  const { data: bulkDetailData } = useQuery({
    queryKey: ["bulk-script-execution-detail", scriptId, bulkDetailRun?.id, bulkDetailStatus, deferredBulkDetailStoreSearch, bulkDetailPage, bulkDetailPageSize],
    queryFn: () => api.get<{ run: BulkScriptRun; summary: ExecutionStats; executions: ScriptCommandExecution[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/api/scripts/${scriptId}/bulk-executions/${bulkDetailRun!.id}?page=${bulkDetailPage}&pageSize=${bulkDetailPageSize}${bulkDetailStatus ? `&status=${bulkDetailStatus}` : ""}${deferredBulkDetailStoreSearch ? `&storeSearch=${encodeURIComponent(deferredBulkDetailStoreSearch)}` : ""}`),
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
    setBulkStorePage(1);
    setBulkSelectedStoreIds([]);
  }, [bulkTenantCode, bulkTunnelStatus, bulkEnrollmentStatus]);
  useEffect(() => {
    if (!initialBulkRunId) {
      handledInitialBulkRunId.current = null;
      return;
    }
    if (!initialBulkDetailData || handledInitialBulkRunId.current === initialBulkRunId) return;
    handledInitialBulkRunId.current = initialBulkRunId;
    setBulkDetailRun({ ...initialBulkDetailData.run, selectedCount: initialBulkDetailData.summary.total, ...initialBulkDetailData.summary });
    setBulkDetailStatus("");
    setBulkDetailStoreSearch("");
    setBulkDetailPage(1);
  }, [initialBulkDetailData, initialBulkRunId]);
  useEffect(() => { setBulkDetailPage(1); setExpandedBulkExecutionId(null); }, [bulkDetailRun?.id, bulkDetailStatus, deferredBulkDetailStoreSearch]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id]);

  useEffect(() => {
    if (selectedVersionData) {
      setContent(selectedVersionData.content);
      setOriginalContent(selectedVersionData.content);
    }
  }, [selectedVersionData]);

  const save = useMutation({
    mutationFn: async () => {
      if (!scriptId) throw new Error("No script selected");
      await api.patch(`/api/scripts/${scriptId}`, { name, language, description, defaultTimeoutMs: defaultTimeoutSeconds * 1000 });
      if (content !== originalContent) return api.post<{ id: string; version: number }>(`/api/scripts/${scriptId}/versions`, { content });
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
        queryClient.invalidateQueries({ queryKey: ["store-detail"] })
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
      filters: { tenantCode: bulkTenantCode || undefined, tunnelStatus: bulkTunnelStatus || undefined, enrollmentStatus: bulkEnrollmentStatus || undefined },
      selectAll: bulkSelectAll,
      timeoutMs: defaultTimeoutSeconds * 1000,
      ...(bulkSelectAll ? {} : { storeIds: bulkSelectedStoreIds })
    }),
    onSuccess: async () => {
      setBulkOpen(false);
      setExecutionPage(1);
      await queryClient.invalidateQueries({ queryKey: ["script-execution-history", scriptId] });
      toast.success("Bulk execution started");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to start bulk execution")
  });

  return <>
    <SideDrawer open={Boolean(scriptId)} zIndex={zIndex} title={<div className="drawer-heading">{detail ? <HostPlatformIcon platform={detail.platform} size={18} /> : null}<strong>{detail?.name ?? "Script details"}</strong></div>} onClose={onClose}>
      {detail && <div className="store-drawer-tab">
        <div className="script-metadata-grid">
          <label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown when an operator selects a script for a store. Names must be unique within the same platform." /></span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
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
        <div className="script-editor-hint-row"><span className="script-editor-hint">{content !== originalContent ? `Creates version ${(detail.latestVersion ?? 0) + 1}` : "No content changes"}</span></div>
        <div className="form-actions script-editor-actions"><div className="critical-actions"><button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => setDeleteOpen(true)}><Trash2 size={15} />Delete script</button><button className="button button-danger" type="button" onClick={() => { setBulkName(`${name} bulk`); setBulkDescription(""); setBulkStorePage(1); setBulkSelectAll(true); setBulkSelectedStoreIds([]); setBulkOpen(true); }}><Layers3 size={15} />Bulk execute</button></div><label className="script-save-timeout"><span className="script-editor-hint">Default timeout (seconds)</span><input type="number" min={1} max={300} value={defaultTimeoutSeconds} onChange={(event) => setDefaultTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label><button className="button button-primary" type="button" disabled={!name.trim() || !content.trim() || save.isPending || deleteScript.isPending} onClick={() => save.mutate()}><Save size={15} />{save.isPending ? "Saving..." : "Save changes"}</button></div>
        {selectedVersion && <section className="script-execution-history"><header><div><h3>Execution history</h3><span>Version {selectedVersion}</span></div><div className="command-history-head-actions"><ExecutionStatsSummary stats={executionSummary} /><span>{executionPagination?.total ?? 0} run{executionPagination?.total === 1 ? "" : "s"}</span><button className="icon-button" type="button" title="Refresh execution history" aria-label="Refresh execution history" disabled={refreshExecutions.isPending || executionsFetching} onClick={() => refreshExecutions.mutate()}><RefreshCw size={14} className={refreshExecutions.isPending || executionsFetching ? "spin-icon" : undefined} /></button></div></header><div className="execution-history-filters"><label className="execution-history-search"><Search size={14} /><input type="search" value={executionSearch} onChange={(event) => setExecutionSearch(event.target.value)} placeholder="Search script, description, store, tenant, or code" aria-label="Search script execution history" /></label><label><span>From</span><input type="datetime-local" step="60" value={executionFrom} onChange={(event) => setExecutionFrom(event.target.value)} aria-label="Filter script execution history from time" /></label><label><span>To</span><input type="datetime-local" step="60" value={executionTo} onChange={(event) => setExecutionTo(event.target.value)} aria-label="Filter script execution history to time" /></label></div>{executionHistory.length ? <div className="script-execution-list">{executionHistory.map((item) => {
          if (item.kind === "bulk") {
            const run = item.run;
            const active = run.scheduled > 0 || run.running > 0;
            const itemId = `bulk:${run.id}`;
            const isExpanded = expandedExecutionId === itemId;
            const runStats = { total: run.selectedCount, scheduled: run.scheduled, running: run.running, succeeded: run.succeeded, failed: run.failed, timedOut: run.timedOut, cancelled: run.cancelled };
            return <details className={`command-execution command-execution-${active ? "running" : "succeeded"}`} key={itemId} open={isExpanded} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(itemId); else if (isExpanded) setExpandedExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={active ? "running" : "succeeded"} label={active ? "Running" : "Complete"} /><span className="command-execution-source-tag">[bulk]</span><strong className="command-execution-inline-name">{run.name}</strong>{!isExpanded && <ExecutionStatsSummary compact stats={runStats} />}</span><span className="command-execution-timing"><time>{new Date(run.createdAt).toLocaleString()}</time><code>{active ? `${run.scheduled + run.running} active` : `${run.selectedCount} complete`}</code></span></summary>{isExpanded && <div className="bulk-run-group-body"><p>{run.description || "No description"}</p><ExecutionStatsSummary stats={runStats} /><div className="bulk-run-meta"><span>{run.selectedCount} stores selected</span><span>{Math.max(0, run.selectedCount - run.scheduled - run.running)} finished</span><span>{run.timeoutMs / 1000}s timeout</span></div><button className="button button-secondary button-small" type="button" onClick={() => { setBulkDetailRun(run); setBulkDetailStatus(""); setBulkDetailStoreSearch(""); setBulkDetailPage(1); }}><Layers3 size={14} />Open bulk run details</button></div>}</details>;
          }
          const execution = item.execution;
          const itemId = `execution:${execution.id}`;
          const statusLabel = execution.status === "succeeded" ? "Succeeded" : execution.status === "failed" ? "Error" : execution.status === "timed_out" ? "Timeout" : execution.status === "cancelled" ? "Cancelled" : execution.status === "scheduled" ? "Scheduled" : "Running";
          const environment = scriptExecutionEnvironment(execution);
          const executionTime = execution.startedAt ?? execution.createdAt;
          return <details className={`command-execution command-execution-${execution.status}`} key={itemId} open={expandedExecutionId === itemId} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(itemId); else if (expandedExecutionId === itemId) setExpandedExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={execution.status} label={statusLabel} /><button className="script-execution-store-link" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openStoreDrawer(execution.storeId, "connect"); }}>{execution.storeDisplayName}</button><code className="command-execution-store-code">{execution.tenantCode} / {execution.storeCode}</code><span className="host-identity" title={environment}><HostPlatformIcon environment={execution.environment} platform={execution.enrollmentPlatform} osName={execution.osName} /><code>{execution.computerName ?? "N/A"}</code></span></span><span className="command-execution-timing"><time>{new Date(executionTime).toLocaleString()}</time><code>{execution.elapsedMs !== null ? `${execution.elapsedMs} ms` : execution.status}</code></span></summary>{expandedExecutionId === itemId && <div className="command-execution-body"><ExecutionLog storeId={execution.storeId} execution={execution} /></div>}</details>;
        })}</div> : <div className="quiet-empty">This script version has not been executed.</div>}{executionPagination && executionPagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous execution page" aria-label="Previous execution page" disabled={executionPagination.page <= 1} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => Math.max(1, page - 1)); }}><ChevronLeft size={15} /></button><span>Page {executionPagination.page} of {executionPagination.totalPages}</span><button className="icon-button" type="button" title="Next execution page" aria-label="Next execution page" disabled={executionPagination.page >= executionPagination.totalPages} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => page + 1); }}><ChevronRight size={15} /></button></div>}</section>}
      </div>}
    </SideDrawer>
    <Modal open={deleteOpen} title={`Delete script · ${name}`} onClose={() => setDeleteOpen(false)}><div className="delete-confirmation"><div className="inline-alert"><AlertTriangle size={15} />This permanently deletes the saved script, every version, and all related execution history. This action cannot be undone.</div><div className="form-actions"><button className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => deleteScript.mutate()}><Trash2 size={15} />{deleteScript.isPending ? "Deleting..." : "Delete permanently"}</button></div></div></Modal>
    <Modal open={bulkOpen} title={`Bulk execute · ${name}`} onClose={() => setBulkOpen(false)} width="wide">
      <div className="bulk-execute-form">
        <div className="script-metadata-grid"><label className="field"><span className="field-label">Run name</span><input value={bulkName} maxLength={120} onChange={(event) => setBulkName(event.target.value)} /></label><label className="field"><span className="field-label">Description</span><input value={bulkDescription} maxLength={1000} onChange={(event) => setBulkDescription(event.target.value)} placeholder="Change ticket, purpose, or rollout context" /></label></div>
        <div className="bulk-filter-grid"><label className="field"><span className="field-label">Tenant code</span><input value={bulkTenantCode} onChange={(event) => setBulkTenantCode(event.target.value)} placeholder="Any tenant" /></label><label className="field"><span className="field-label">Tunnel status</span><select value={bulkTunnelStatus} onChange={(event) => setBulkTunnelStatus(event.target.value)}><option value="">Any tunnel status</option><option value="not_created">Not created</option><option value="inactive">Inactive</option><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="down">Down</option><option value="unknown">Unknown</option></select></label><label className="field"><span className="field-label">Enrollment status</span><select value={bulkEnrollmentStatus} onChange={(event) => setBulkEnrollmentStatus(event.target.value)}><option value="">Any enrollment status</option><option value="active">Active</option><option value="waiting_for_new_enrollment">Waiting for new enrollment</option><option value="url_issued">URL issued</option><option value="claimed">Claimed</option><option value="provisioning">Provisioning</option><option value="expired">Expired</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select></label></div>
        <div className="bulk-match-banner"><strong>{bulkStoreData?.pagination.total ?? 0} stores matched</strong><label><input type="checkbox" checked={bulkSelectAll} onChange={(event) => setBulkSelectAll(event.target.checked)} />Select all matched stores, including results on other pages</label></div>
        <div className="bulk-store-table"><table><thead><tr><th>#</th><th aria-label="Select store" /><th>Store</th><th>Tenant / code</th><th>Status</th></tr></thead><tbody>{bulkStoreData?.stores.length ? bulkStoreData.stores.map((store, index) => <tr key={store.id}><td>{(bulkStorePage - 1) * bulkStorePageSize + index + 1}</td><td><input type="checkbox" disabled={bulkSelectAll} checked={bulkSelectAll || bulkSelectedStoreIds.includes(store.id)} aria-label={`Select ${store.displayName}`} onChange={(event) => setBulkSelectedStoreIds((current) => event.target.checked ? [...new Set([...current, store.id])] : current.filter((id) => id !== store.id))} /></td><td><strong>{store.displayName}</strong></td><td><code>{store.tenantCode} / {store.storeCode}</code></td><td><StatusBadge status={store.onboardingStatus} /></td></tr>) : <tr><td colSpan={5}><div className="quiet-empty">No stores match these filters.</div></td></tr>}</tbody></table></div>
        {bulkStoreData && bulkStoreData.pagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous store page" aria-label="Previous store page" disabled={bulkStorePage <= 1} onClick={() => setBulkStorePage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span>Page {bulkStorePage} of {bulkStoreData.pagination.totalPages}</span><button className="icon-button" type="button" title="Next store page" aria-label="Next store page" disabled={bulkStorePage >= bulkStoreData.pagination.totalPages} onClick={() => setBulkStorePage((page) => page + 1)}><ChevronRight size={15} /></button></div>}
        <div className="form-actions"><span>{bulkSelectAll ? `${bulkStoreData?.pagination.total ?? 0} selected` : `${bulkSelectedStoreIds.length} selected`} · timeout {defaultTimeoutSeconds}s</span><button className="button button-secondary" type="button" onClick={() => setBulkOpen(false)}>Cancel</button><button className="button button-primary" type="button" disabled={!bulkName.trim() || !selectedVersionData || bulkExecute.isPending || (bulkSelectAll ? !bulkStoreData?.pagination.total : !bulkSelectedStoreIds.length)} onClick={() => bulkExecute.mutate()}><Play size={15} />{bulkExecute.isPending ? "Starting..." : "Execute selected"}</button></div>
      </div>
    </Modal>
    <SideDrawer open={Boolean(bulkDetailRun)} zIndex={(zIndex ?? 100) + 2} title={<div className="drawer-heading"><Layers3 size={18} /><strong>{bulkDetailRun?.name ?? "Bulk execution"}</strong></div>} onClose={() => setBulkDetailRun(null)}>
      {bulkDetailRun && <div className="bulk-execution-detail"><header><div><span>Description v{bulkDetailRun.descriptionVersion}</span><p>{bulkDetailRun.description || "No description"}</p></div><time>{new Date(bulkDetailRun.createdAt).toLocaleString()}</time></header>{(() => {
        const previewVersion = detail?.versions.find((entry) => entry.id === bulkDetailRun.scriptVersionId) ?? selectedVersionData;
        return previewVersion ? <div className="command-script-preview bulk-script-preview"><header><div><strong>Script preview</strong><span>{detail?.name ?? "Script"} · Version {previewVersion.version}</span></div><code>{detail?.language ?? ""}</code></header><ScriptEditor value={previewVersion.content} language={detail?.language ?? "powershell"} height="220px" readOnly /></div> : null;
      })()}<ExecutionStatsSummary stats={bulkDetailData?.summary ?? { total: bulkDetailRun.selectedCount, scheduled: bulkDetailRun.scheduled, running: bulkDetailRun.running, succeeded: bulkDetailRun.succeeded, failed: bulkDetailRun.failed, timedOut: bulkDetailRun.timedOut, cancelled: bulkDetailRun.cancelled }} />
        <div className="bulk-detail-filters"><select value={bulkDetailStatus} onChange={(event) => setBulkDetailStatus(event.target.value)} aria-label="Filter bulk executions by status"><option value="">All statuses</option><option value="scheduled">Scheduled</option><option value="running">Running</option><option value="succeeded">Succeeded</option><option value="failed">Error</option><option value="timed_out">Timeout</option><option value="cancelled">Cancelled</option></select><input type="search" value={bulkDetailStoreSearch} onChange={(event) => setBulkDetailStoreSearch(event.target.value)} aria-label="Filter bulk executions by store name, tenant code, or store code" placeholder="Filter store name, tenant, or code" /></div>
        <div className="script-execution-list">{bulkDetailData?.executions.map((execution) => {
          const environment = scriptExecutionEnvironment(execution);
          const isOpen = expandedBulkExecutionId === execution.id;
          return <details className={`command-execution command-execution-${execution.status}`} key={execution.id} open={isOpen} onToggle={(event) => { if (event.currentTarget.open) setExpandedBulkExecutionId(execution.id); else if (expandedBulkExecutionId === execution.id) setExpandedBulkExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={execution.status} /><button className="script-execution-store-link" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openStoreDrawer(execution.storeId, "connect"); }}>{execution.storeDisplayName}</button><code className="command-execution-store-code">{execution.tenantCode} / {execution.storeCode}</code><span className="host-identity" title={environment}><HostPlatformIcon environment={execution.environment} platform={execution.enrollmentPlatform} osName={execution.osName} /><code>{execution.computerName ?? "N/A"}</code></span></span><span className="command-execution-timing"><time>{new Date(execution.startedAt ?? execution.createdAt).toLocaleString()}</time><code>{execution.elapsedMs === null ? execution.status : `${execution.elapsedMs} ms`}</code></span></summary>{isOpen && <div className="command-execution-body"><ExecutionLog storeId={execution.storeId} execution={execution} /></div>}</details>;
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
