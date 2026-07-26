import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Search, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { useDrawers, type StoreDrawerTab } from "../components/DrawerContext";
import { PageHeader } from "../components/PageHeader";
import { SearchableSelect } from "../components/SearchableSelect";
import { StatusBadge, storeNeedsFastPolling, tunnelOnlineStatus } from "../components/StatusBadge";
import type { Store } from "../types";

export type { StoreDrawerTab };

type StoreListResponse = {
  stores: Store[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type StoreRefreshResponse = {
  success: boolean;
  refreshed: number;
  failed: number;
};

export function StoresPage() {
  const queryClient = useQueryClient();
  const { openStoreDrawer } = useDrawers();
  const [search, setSearch] = useState("");
  const [tenantCode, setTenantCode] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState("");
  const [enrollmentStatus, setEnrollmentStatus] = useState("");
  const [page, setPage] = useState(1);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const pageSize = 25;
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search) params.set("search", search);
  if (tenantCode) params.set("tenantCode", tenantCode);
  if (tunnelStatus) params.set("tunnelStatus", tunnelStatus);
  if (enrollmentStatus) params.set("enrollmentStatus", enrollmentStatus);
  const { data, isLoading } = useQuery({
    queryKey: ["stores", search, tenantCode, tunnelStatus, enrollmentStatus, page, pageSize],
    queryFn: () => api.get<StoreListResponse>(`/api/stores?${params.toString()}`),
    refetchInterval: (query) => query.state.data?.stores.some((store) => storeNeedsFastPolling(store)) ? 2000 : false
  });
  const { data: tenantCodesData } = useQuery({
    queryKey: ["tenant-codes"],
    queryFn: () => api.get<{ tenantCodes: string[] }>("/api/stores/tenant-codes")
  });
  const tenantCodeOptions = useMemo(() => [{ value: "", label: "Any tenant" }, ...(tenantCodesData?.tenantCodes ?? []).map((code) => ({ value: code, label: code }))], [tenantCodesData]);
  const refreshStores = async (storeIds: string[]) => {
    try {
      await api.post<StoreRefreshResponse>("/api/stores/refresh", { storeIds });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh store status");
    } finally {
      setRefreshingIds((current) => {
        const next = new Set(current);
        for (const id of storeIds) next.delete(id);
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["stores"] }),
        ...storeIds.map((storeId) => queryClient.invalidateQueries({ queryKey: ["store-detail", storeId] })),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
    }
  };
  const refreshAll = () => {
    const ids = data?.stores.map((store) => store.id) ?? [];
    if (!ids.length) return;
    setRefreshingIds(new Set(ids));
    void refreshStores(ids);
  };
  useEffect(() => setPage(1), [search, tenantCode, tunnelStatus, enrollmentStatus]);
  const pagination = data?.pagination;
  const firstResult = pagination && pagination.total > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const lastResult = pagination ? Math.min(pagination.page * pagination.pageSize, pagination.total) : 0;
  return (
    <div className="page">
      <PageHeader title="Stores" eyebrow="Tunnel inventory" actions={<><button className="button button-secondary" onClick={refreshAll} disabled={refreshingIds.size > 0 || !data?.stores.length}><RefreshCw size={15} className={refreshingIds.size > 0 ? "spin-icon" : undefined} />{refreshingIds.size > 0 ? "Refreshing..." : "Refresh"}</button><Link className="button button-primary" to="/onboarding"><Plus size={16} />Onboard store</Link></>} />
      <div className="toolbar">
        <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search stores or hostnames" /></label>
        <div className="toolbar-tenant-filter"><SearchableSelect name="tenantCodeFilter" options={tenantCodeOptions} value={tenantCode} ariaLabel="Filter by tenant code" emptyMessage="No matching tenant" onValueChange={setTenantCode} /></div>
        <select value={tunnelStatus} onChange={(event) => setTunnelStatus(event.target.value)} aria-label="Filter tunnel status"><option value="">All tunnel statuses</option><option value="not_created">Not created</option><option value="inactive">Inactive</option><option value="healthy">Healthy</option><option value="degraded">Degraded</option><option value="down">Down</option><option value="unknown">Unknown</option></select>
        <select value={enrollmentStatus} onChange={(event) => setEnrollmentStatus(event.target.value)} aria-label="Filter enrollment status"><option value="">All enrollment statuses</option><option value="active">Active</option><option value="verified">Verified</option><option value="waiting_for_new_enrollment">Waiting for new enrollment</option><option value="url_issued">URL issued</option><option value="claimed">Claimed</option><option value="provisioning">Provisioning</option><option value="connector_online">Connector online</option><option value="unenrolled">Unenrolled</option><option value="expired">Expired</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select>
        <span className="result-count">{pagination?.total ?? 0} stores</span>
      </div>
      <section className="panel table-panel store-table-panel">
        <div className="table-scroll"><table><thead><tr><th>Store</th><th>Assignment</th><th>Tunnel</th><th>Enrollment</th><th>Commands</th></tr></thead><tbody>
          {isLoading ? <tr><td colSpan={5}><div className="quiet-empty">Loading stores...</div></td></tr> : data?.stores.length === 0 ? <tr><td colSpan={5}><div className="quiet-empty">No stores match this view</div></td></tr> : data?.stores.map((store) => {
            const refreshing = refreshingIds.has(store.id);
            return <tr key={store.id} className="data-row" onClick={() => openStoreDrawer(store.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openStoreDrawer(store.id); } }} tabIndex={0}><td><div className="primary-cell"><strong>{store.displayName}</strong><span>{store.tenantCode} · {store.storeCode}</span></div></td><td><div className="primary-cell"><strong>{store.accountName}</strong><span>{store.zoneName}</span></div></td><td>{refreshing ? <StatusBadge status="refreshing" /> : <StatusBadge status={tunnelOnlineStatus(store.tunnelStatus)} />}</td><td>{refreshing ? <StatusBadge status="refreshing" /> : <StatusBadge status={store.onboardingStatus} />}</td><td>{store.commandAgent && <button className="icon-button command-agent-table-action" type="button" title="Open Connect tab" aria-label={`Open Connect tab for ${store.displayName}`} onClick={(event) => { event.stopPropagation(); openStoreDrawer(store.id, "connect"); }}><TerminalSquare size={17} /></button>}</td></tr>;
          })}
        </tbody></table></div>
        {pagination && pagination.total > 0 && <div className="table-pagination"><span>{firstResult}-{lastResult} of {pagination.total}</span><div><button className="icon-button" title="Previous page" aria-label="Previous page" disabled={pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={17} /></button><span>Page {pagination.page} of {pagination.totalPages}</span><button className="icon-button" title="Next page" aria-label="Next page" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button></div></div>}
      </section>
    </div>
  );
}
