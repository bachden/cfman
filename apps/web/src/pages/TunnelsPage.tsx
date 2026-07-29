import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Search, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { useDrawers, type TunnelDrawerTab } from "../components/DrawerContext";
import { PageHeader } from "../components/PageHeader";
import { SearchableSelect } from "../components/SearchableSelect";
import { StatusBadge, tunnelNeedsFastPolling, tunnelOnlineStatus } from "../components/StatusBadge";
import type { Tunnel } from "../types";

export type { TunnelDrawerTab };

type TunnelListResponse = {
  tunnels: Tunnel[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type TunnelRefreshResponse = {
  success: boolean;
  refreshed: number;
  failed: number;
};

export function TunnelsPage() {
  const queryClient = useQueryClient();
  const { openTunnelDrawer } = useDrawers();
  const [search, setSearch] = useState("");
  const [tenantCode, setTenantCode] = useState("");
  const [cfTunnelStatus, setCfTunnelStatus] = useState("");
  const [enrollmentStatus, setEnrollmentStatus] = useState("");
  const [page, setPage] = useState(1);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const pageSize = 25;
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search) params.set("search", search);
  if (tenantCode) params.set("tenantCode", tenantCode);
  if (cfTunnelStatus) params.set("cfTunnelStatus", cfTunnelStatus);
  if (enrollmentStatus) params.set("enrollmentStatus", enrollmentStatus);
  const { data, isLoading } = useQuery({
    queryKey: ["tunnels", search, tenantCode, cfTunnelStatus, enrollmentStatus, page, pageSize],
    queryFn: () => api.get<TunnelListResponse>(`/api/tunnels?${params.toString()}`),
    refetchInterval: (query) => query.state.data?.tunnels.some((tunnel) => tunnelNeedsFastPolling(tunnel)) ? 2000 : false
  });
  const { data: tenantCodesData } = useQuery({
    queryKey: ["tenant-codes"],
    queryFn: () => api.get<{ tenantCodes: string[] }>("/api/tunnels/tenant-codes")
  });
  const tenantCodeOptions = useMemo(() => [{ value: "", label: "Any tenant" }, ...(tenantCodesData?.tenantCodes ?? []).map((code) => ({ value: code, label: code }))], [tenantCodesData]);
  const refreshTunnels = async (tunnelIds: string[]) => {
    try {
      await api.post<TunnelRefreshResponse>("/api/tunnels/refresh", { tunnelIds });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh connectivity status");
    } finally {
      setRefreshingIds((current) => {
        const next = new Set(current);
        for (const id of tunnelIds) next.delete(id);
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        ...tunnelIds.map((tunnelId) => queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] })),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  };
  const refreshAll = () => {
    const ids = data?.tunnels.map((tunnel) => tunnel.id) ?? [];
    if (!ids.length) return;
    setRefreshingIds(new Set(ids));
    void refreshTunnels(ids);
  };
  useEffect(() => setPage(1), [search, tenantCode, cfTunnelStatus, enrollmentStatus]);
  const pagination = data?.pagination;
  const firstResult = pagination && pagination.total > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const lastResult = pagination ? Math.min(pagination.page * pagination.pageSize, pagination.total) : 0;
  return (
    <div className="page">
      <PageHeader title="Tunnels" eyebrow="Tunnel inventory" actions={<><button className="button button-secondary" onClick={refreshAll} disabled={refreshingIds.size > 0 || !data?.tunnels.length}><RefreshCw size={15} className={refreshingIds.size > 0 ? "spin-icon" : undefined} />{refreshingIds.size > 0 ? "Refreshing..." : "Refresh"}</button><Link className="button button-primary" to="/onboarding"><Plus size={16} />Onboard tunnel</Link></>} />
      <div className="toolbar">
        <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tunnels or hostnames" /></label>
        <div className="toolbar-tenant-filter"><SearchableSelect name="tenantCodeFilter" options={tenantCodeOptions} value={tenantCode} ariaLabel="Filter by tenant code" emptyMessage="No matching tenant" onValueChange={setTenantCode} /></div>
        <select value={cfTunnelStatus} onChange={(event) => setCfTunnelStatus(event.target.value)} aria-label="Filter connectivity status"><option value="">All connectivity statuses</option><option value="not_created">Not created</option><option value="inactive">Inactive</option><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="down">Down</option><option value="unknown">Unknown</option></select>
        <select value={enrollmentStatus} onChange={(event) => setEnrollmentStatus(event.target.value)} aria-label="Filter enrollment status"><option value="">All enrollment statuses</option><option value="active">Active</option><option value="verified">Verified</option><option value="waiting_for_new_enrollment">Waiting for new enrollment</option><option value="url_issued">URL issued</option><option value="claimed">Claimed</option><option value="provisioning">Provisioning</option><option value="connector_online">Connector online</option><option value="unenrolled">Unenrolled</option><option value="expired">Expired</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select>
        <span className="result-count">{pagination?.total ?? 0} tunnels</span>
      </div>
      <section className="panel table-panel tunnel-table-panel">
        <div className="table-scroll"><table><thead><tr><th>Tunnel</th><th>Assignment</th><th>Connectivity</th><th>Enrollment</th><th>Commands</th></tr></thead><tbody>
          {isLoading ? <tr><td colSpan={5}><div className="quiet-empty">Loading tunnels...</div></td></tr> : data?.tunnels.length === 0 ? <tr><td colSpan={5}><div className="quiet-empty">No tunnels match this view</div></td></tr> : data?.tunnels.map((tunnel) => {
            const refreshing = refreshingIds.has(tunnel.id);
            return <tr key={tunnel.id} className="data-row" onClick={() => openTunnelDrawer(tunnel.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTunnelDrawer(tunnel.id); } }} tabIndex={0}><td><div className="primary-cell"><strong>{tunnel.displayName}</strong><span>{tunnel.tenantCode} · {tunnel.tunnelCode}</span></div></td><td><div className="primary-cell"><strong>{tunnel.accountName}</strong><span>{tunnel.zoneName}</span></div></td><td>{refreshing ? <StatusBadge status="refreshing" /> : <StatusBadge status={tunnelOnlineStatus(tunnel.cfTunnelStatus)} />}</td><td>{refreshing ? <StatusBadge status="refreshing" /> : <StatusBadge status={tunnel.onboardingStatus} />}</td><td>{tunnel.commandAgent && <button className="icon-button command-agent-table-action" type="button" title="Open Connect tab" aria-label={`Open Connect tab for ${tunnel.displayName}`} onClick={(event) => { event.stopPropagation(); openTunnelDrawer(tunnel.id, "connect"); }}><TerminalSquare size={17} /></button>}</td></tr>;
          })}
        </tbody></table></div>
        {pagination && pagination.total > 0 && <div className="table-pagination"><span>{firstResult}-{lastResult} of {pagination.total}</span><div><button className="icon-button" title="Previous page" aria-label="Previous page" disabled={pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={17} /></button><span>Page {pagination.page} of {pagination.totalPages}</span><button className="icon-button" title="Next page" aria-label="Next page" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button></div></div>}
      </section>
    </div>
  );
}
