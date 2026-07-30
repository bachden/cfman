import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Braces, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, FilePlus2, Globe2, Layers3, MonitorUp, RefreshCw, Save, Search, Settings2, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { emptyExecutionStats, type AppSettings, type ArgumentBindings, type CloudflareAccount, type DiagnoseResult, type EnrollmentResult, type ExecutionStats, type ExecutionVariables, type ManagedScript, type ManagedScriptSummary, type ScriptArgument, type Tunnel, type TunnelCommandExecution, type TunnelDeletePreflight, type TunnelEnrollment, type TunnelRoute, type UnenrollmentResult } from "../types";
import { ConnectivityEditor, connectivityPayload, validatePublications, type DraftPublication } from "./ConnectivityEditor";
import { CopyButton } from "./CopyButton";
import { useDrawers, type TunnelDrawerTab } from "./DrawerContext";
import { ExecutionLog } from "./ExecutionLog";
import { ExecutionStatsSummary } from "./ExecutionStatsSummary";
import { AddVariableButton, ArgumentBindingsEditor, ExecutionVariablesEditor, InlineArgumentsEditor, missingRequiredArgumentNames, ScriptArgumentsEditor } from "./ExecutionVariablesEditor";
import { FieldHelp } from "./FieldHelp";
import { HostPlatformIcon } from "./HostPlatformIcon";
import { Modal } from "./Modal";
import { ScriptEditor } from "./ScriptEditor";
import { SearchableSelect } from "./SearchableSelect";
import { SideDrawer } from "./SideDrawer";
import { StatusBadge, activeEnrollmentPlatform, cfmanSelfPublication, isCfmanSelfTunnel, tunnelNeedsFastPolling, tunnelOnlineStatus } from "./StatusBadge";

export type { TunnelDrawerTab };

export function TunnelDrawer({ tunnelId, tab, initialExpandEnrollmentId, onTabChange, onClose, zIndex }: { tunnelId: string | null; tab: TunnelDrawerTab; initialExpandEnrollmentId?: string | null | undefined; onTabChange: (tab: TunnelDrawerTab) => void; onClose: () => void; zIndex?: number | undefined }) {
  const queryClient = useQueryClient();
  const [enrollmentPage, setEnrollmentPage] = useState(1);
  const [autoExpandEnrollmentId, setAutoExpandEnrollmentId] = useState<string | null>(null);
  // Opening the drawer straight to a specific enrollment (e.g. right after
  // onboarding a new tunnel) reuses the same auto-expand state the drawer's
  // own "issue enrollment" mutation already drives - just seeded from the
  // caller instead of from an internal mutation result.
  useEffect(() => {
    if (initialExpandEnrollmentId) setAutoExpandEnrollmentId(initialExpandEnrollmentId);
  }, [initialExpandEnrollmentId, tunnelId]);
  const [unenrollTarget, setUnenrollTarget] = useState<TunnelEnrollment | null>(null);
  const [automaticUnenroll, setAutomaticUnenroll] = useState(true);
  const [deleteEnrollmentTarget, setDeleteEnrollmentTarget] = useState<TunnelEnrollment | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePreflight, setDeletePreflight] = useState<TunnelDeletePreflight | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [editingConnectivity, setEditingConnectivity] = useState(false);
  const [reassigningZone, setReassigningZone] = useState(false);
  const [wafRoute, setWafRoute] = useState<TunnelRoute | null>(null);
  const [enableSshOpen, setEnableSshOpen] = useState(false);
  const [troubleshootOpen, setTroubleshootOpen] = useState(false);
  const [tunnelVariablesOpen, setTunnelVariablesOpen] = useState(false);
  const { data: detailData } = useQuery({
    queryKey: ["tunnel-detail", tunnelId],
    queryFn: () => api.get<{ tunnel: Tunnel }>(`/api/tunnels/${tunnelId}`),
    enabled: Boolean(tunnelId),
    refetchInterval: (query) => {
      const tunnel = query.state.data?.tunnel;
      return tunnel && tunnelNeedsFastPolling(tunnel) ? 2000 : false;
    }
  });
  const currentTunnel = detailData?.tunnel;
  const { data: settingsData } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: AppSettings }>("/api/settings") });
  const publicBaseUrl = settingsData?.settings.publicBaseUrl;
  const isCfmanSelf = currentTunnel ? isCfmanSelfTunnel(currentTunnel, publicBaseUrl) : false;
  const drawerHostPlatform = currentTunnel ? activeEnrollmentPlatform(currentTunnel) : null;
  const sshRoutePublication = currentTunnel?.publications.find((publication) => publication.routes.some((route) => route.serviceUrl.startsWith("ssh://")));
  const sshRoute = sshRoutePublication?.routes.find((route) => route.serviceUrl.startsWith("ssh://"));
  const sshDirectRouteCommand = sshRoutePublication ? `ssh -o ProxyCommand="cloudflared access ssh --hostname ${sshRoutePublication.hostname}" ${currentTunnel?.sshUsername ?? "root"}@${sshRoutePublication.hostname}` : "";
  const enrollmentPageSize = 5;
  const { data: enrollmentData } = useQuery({
    queryKey: ["tunnel-enrollments", tunnelId, enrollmentPage, enrollmentPageSize],
    queryFn: () => api.get<{ enrollments: TunnelEnrollment[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }>(`/api/tunnels/${tunnelId}/enrollments?page=${enrollmentPage}&pageSize=${enrollmentPageSize}`),
    enabled: Boolean(tunnelId && tab === "overall"),
    refetchInterval: (query) => query.state.data?.enrollments.some((enrollment) => ["never_run", "running", "unenroll_pending"].includes(enrollmentDisplayStatus(enrollment))) ? 2000 : false
  });
  const enrollmentPagination = enrollmentData?.pagination;
  useEffect(() => { setEditingConnectivity(false); setTroubleshootOpen(false); setEnrollmentPage(1); }, [tunnelId]);
  useEffect(() => {
    if (enrollmentPagination && enrollmentPage > enrollmentPagination.totalPages) setEnrollmentPage(enrollmentPagination.totalPages);
  }, [enrollmentPage, enrollmentPagination]);
  const mutation = useMutation({
    mutationFn: () => api.post<EnrollmentResult>(`/api/tunnels/${tunnelId}/enrollments`, { expiresInHours: 24 }),
    onSuccess: async (result) => { setEnrollmentPage(1); setAutoExpandEnrollmentId(result.id); toast.success("Enrollment URL issued"); await Promise.all([queryClient.invalidateQueries({ queryKey: ["tunnels"] }), queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] }), queryClient.invalidateQueries({ queryKey: ["tunnel-enrollments", tunnelId] })]); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to issue enrollment")
  });
  const verify = useMutation({
    mutationFn: (routeId: string) => api.post<{ success: boolean; check: { statusCode: number | null; latencyMs: number; error?: string }; checks: unknown[] }>(`/api/tunnels/${tunnelId}/verify`, { routeId }),
    onSuccess: async (result) => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["tunnels"] }), queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] })]); if (result.success) toast.success("Endpoint verified"); else toast.error(result.check.error ?? "Endpoint is unreachable"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Verification failed")
  });
  const reconcileCfmanSelf = useMutation({
    mutationFn: () => api.post<{ hostname: string; routes: Array<{ path: string; created: boolean }>; warning: string | null }>(`/api/tunnels/${tunnelId}/reconcile-cfman-self`),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] })
      ]);
      const created = result.routes.filter((route) => route.created).map((route) => route.path);
      if (result.warning) toast.warning(result.warning);
      else if (created.length) toast.success(`Created missing route${created.length === 1 ? "" : "s"}: ${created.join(", ")}`);
      else toast.success("Already up to date - WAF rule and remote-agent routes are correct");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to reconcile CFMan's own WAF configuration")
  });
  const deleteEnrollment = useMutation({
    mutationFn: (enrollmentId: string) => api.delete<{ hardDeleted: boolean; logCount?: number }>(`/api/tunnels/${tunnelId}/enrollments/${enrollmentId}`),
    onSuccess: async () => {
      setDeleteEnrollmentTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-enrollments", tunnelId] }),
        queryClient.invalidateQueries({ queryKey: ["tunnels"] })
      ]);
      toast.success("Enrollment permanently deleted; logs are no longer available");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete enrollment")
  });
  const reassignZone = useMutation({
    mutationFn: (zoneId: string) => api.patch(`/api/tunnels/${tunnelId}/zone`, { zoneId }),
    onSuccess: async () => {
      setReassigningZone(false);
      toast.success("Account/zone updated");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] }),
        queryClient.invalidateQueries({ queryKey: ["tunnels"] })
      ]);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to change account/zone")
  });
  const issueUnenrollment = useMutation({
    mutationFn: ({ enrollmentId, automatic }: { enrollmentId: string; automatic: boolean }) => api.post<UnenrollmentResult>(`/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/unenroll`, { expiresInHours: 24, automatic }),
    onSuccess: async (result) => {
      setUnenrollTarget(null);
      setEnrollmentPage(1);
      setAutoExpandEnrollmentId(result.enrollmentId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-enrollments", tunnelId] }),
        queryClient.invalidateQueries({ queryKey: ["tunnels"] })
      ]);
      if (result.automatic?.status === "scheduled") toast.success("Automatic unenrollment scheduled");
      else if (result.automatic) toast.warning(`${result.automatic.error ?? "Automatic unenrollment is unavailable"}. Use the manual command.`);
      else toast.success("Unenrollment command issued");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to issue unenrollment command")
  });
  const retryRdp = useMutation({
    mutationFn: () => api.post(`/api/tunnels/${tunnelId}/rdp/retry`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] })
      ]);
      toast.success("Browser RDP provisioned");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "RDP provisioning failed")
  });
  const enableRds = useMutation({
    mutationFn: () => api.post<{ scheduled?: boolean }>(`/api/tunnels/${tunnelId}/rdp/enable`),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] })
      ]);
      toast.success(result.scheduled ? "Enabling Remote Desktop - this can take up to a minute" : "Remote Desktop enabled and browser RDP provisioned");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to enable Remote Desktop")
  });
  const retrySsh = useMutation({
    mutationFn: () => api.post(`/api/tunnels/${tunnelId}/ssh/retry`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] })
      ]);
      toast.success("Browser SSH provisioned");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "SSH provisioning failed")
  });
  const deletePreflightMutation = useMutation({
    mutationFn: () => api.get<TunnelDeletePreflight>(`/api/tunnels/${tunnelId}/delete-preflight`),
    onSuccess: (result) => setDeletePreflight(result),
    onError: (error) => { setDeleteOpen(false); toast.error(error instanceof Error ? error.message : "Unable to check tunnel deletion readiness"); }
  });
  const deleteTunnel = useMutation({
    mutationFn: () => api.delete(`/api/tunnels/${tunnelId}`, {
      force: Boolean(deletePreflight && !deletePreflight.canDelete),
      ...(deletePreflight && !deletePreflight.canDelete ? { confirmName: deleteName } : {})
    }),
    onSuccess: async () => {
      setDeleteOpen(false);
      setDeletePreflight(null);
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
      toast.success("Tunnel deleted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Unable to delete tunnel");
      deletePreflightMutation.mutate();
    }
  });
  const openDelete = () => {
    setDeleteName("");
    setDeletePreflight(null);
    setDeleteOpen(true);
    deletePreflightMutation.mutate();
  };
  const openUnenroll = (target: TunnelEnrollment) => {
    setAutomaticUnenroll(Boolean(currentTunnel?.commandAgent?.status === "ready" && target.platform));
    setUnenrollTarget(target);
  };
  const close = () => { setAutoExpandEnrollmentId(null); setUnenrollTarget(null); setDeleteEnrollmentTarget(null); setDeleteOpen(false); setDeletePreflight(null); setDeleteName(""); setEditingConnectivity(false); setWafRoute(null); setEnableSshOpen(false); setTroubleshootOpen(false); onClose(); };
  return (
    <>
    <SideDrawer open={Boolean(tunnelId)} zIndex={zIndex} title={<div className="drawer-heading"><strong>{currentTunnel?.displayName ?? "Tunnel details"}</strong>{isCfmanSelf && <span className="cfman-self-tag" title="This tunnel is CFMan's own self-hosted target">CFMAN SELF</span>}{currentTunnel && <StatusBadge status={tunnelOnlineStatus(currentTunnel.cfTunnelStatus)} />}</div>} onClose={close}>
      {currentTunnel && <div className="tunnel-drawer-content">
        <nav className="tunnel-drawer-tabs" aria-label="Tunnel detail sections">
          <button className={tab === "overall" ? "active" : ""} type="button" onClick={() => onTabChange("overall")}>Overall</button>
          <button className={tab === "ingress" ? "active" : ""} type="button" onClick={() => onTabChange("ingress")}>Ingress routes</button>
          <button className={tab === "connect" ? "active" : ""} type="button" onClick={() => onTabChange("connect")}>Connect</button>
        </nav>
        {tab === "overall" && <div className="tunnel-drawer-tab">
          {currentTunnel.wafWarning && <div className="inline-alert"><AlertTriangle size={14} />WAF rule could not be applied for one or more routes - they're reachable without WAF protection: {currentTunnel.wafWarning}</div>}
          <section className="tunnel-drawer-section">
            <header className="tunnel-section-heading"><div><h3>Tunnel overview</h3><span>Tunnel assignment and infrastructure</span></div><div className="tunnel-section-heading-actions"><button className="button button-secondary" type="button" onClick={() => setTunnelVariablesOpen(true)}><Braces size={15} />Variables</button></div></header>
            <dl className="detail-list">
              <div><dt>Tunnel code</dt><dd>{currentTunnel.tenantCode} / {currentTunnel.tunnelCode}</dd></div>
              <div><dt>Account</dt><dd>{currentTunnel.accountName}</dd></div>
              {/* Reassignment is driven by the zone - the account follows from it - so the
                  action lives on the value it changes instead of in the section header. */}
              <div><dt>Zone</dt><dd className="detail-value-row"><span>{currentTunnel.zoneName}</span>{!currentTunnel.cfTunnelId && !(currentTunnel.enrollments ?? []).some((enrollment) => enrollment.isCurrent) && <button className="button button-secondary button-small" type="button" title="Change account/zone" onClick={() => setReassigningZone(true)}><Settings2 size={14} />Change</button>}</dd></div>
              <div><dt>Tunnel</dt><dd>{currentTunnel.cfTunnelId ? currentTunnel.cfAccountId ? <a className="mono detail-link" href={`https://dash.cloudflare.com/${encodeURIComponent(currentTunnel.cfAccountId)}/tunnels/${encodeURIComponent(currentTunnel.cfTunnelId)}/overview`} target="_blank" rel="noreferrer" title="Open tunnel details in Cloudflare">{currentTunnel.cfTunnelName ?? currentTunnel.cfTunnelId}</a> : <span className="mono">{currentTunnel.cfTunnelName ?? currentTunnel.cfTunnelId}</span> : "Not provisioned"}</dd></div>
            </dl>
          </section>
          <div className="detail-actions">
            <button className="button button-danger" onClick={openDelete} disabled={deletePreflightMutation.isPending || deleteTunnel.isPending}><Trash2 size={15} />Delete tunnel</button>
            <div className="detail-actions-secondary"><button className="button button-secondary" onClick={() => setTroubleshootOpen(true)}><RefreshCw size={15} />Troubleshoot</button><button className="button button-primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}><TerminalSquare size={16} />{mutation.isPending ? "Issuing..." : "New enrollment"}</button></div>
          </div>
          <EnrollmentHistory tunnelId={currentTunnel.id} enrollments={enrollmentData?.enrollments ?? []} pagination={enrollmentPagination} autoExpandId={autoExpandEnrollmentId} onPageChange={setEnrollmentPage} onDelete={(enrollment) => setDeleteEnrollmentTarget(enrollment)} onUnenroll={openUnenroll} deleting={deleteEnrollment.isPending} unenrolling={issueUnenrollment.isPending} />
          {(() => {
            const online = tunnelOnlineStatus(currentTunnel.cfTunnelStatus) === "online";
            const activeEnrollment = (currentTunnel.enrollments ?? []).find((item) => item.isCurrent);
            const hasEnrollments = (currentTunnel.enrollments ?? []).length > 0;
            if (!online && activeEnrollment) {
              return <div className="inline-alert status-mismatch-hint">
                <span><AlertTriangle size={14} />Tunnel is offline but this enrollment still shows Active. Check the tunnel machine's network connection, then troubleshoot.</span>
                <button className="button button-secondary" type="button" onClick={() => setTroubleshootOpen(true)}><RefreshCw size={14} />Troubleshoot</button>
              </div>;
            }
            if (online && !activeEnrollment && hasEnrollments) {
              return <div className="inline-alert status-mismatch-hint">
                <span><AlertTriangle size={14} />Tunnel is online but the enrollment shows a failure. Troubleshoot to check the command agent and endpoints - if they respond, we'll mark it installed again.</span>
                <button className="button button-secondary" type="button" onClick={() => setTroubleshootOpen(true)}><RefreshCw size={14} />Troubleshoot</button>
              </div>;
            }
            return null;
          })()}
        </div>}
        {tab === "ingress" && <div className="tunnel-drawer-tab">
          {editingConnectivity ? <EditConnectivityPanel tunnel={currentTunnel} onClose={() => setEditingConnectivity(false)} /> : <section className="tunnel-drawer-section publication-summary"><header className="tunnel-section-heading"><div><h3>Published endpoints</h3><span>{currentTunnel.publications.length} hostname{currentTunnel.publications.length === 1 ? "" : "s"}</span></div><button className="button button-secondary" type="button" onClick={() => setEditingConnectivity(true)}><Settings2 size={15} />Edit connectivity</button></header>{currentTunnel.publications.map((publication) => <div className="publication-summary-item" key={publication.id}><div className="publication-summary-head"><code>{publication.hostname}</code>{isCfmanSelf && cfmanSelfPublication(currentTunnel, publicBaseUrl)?.id === publication.id && <><span className="cfman-self-tag" title="This tunnel is CFMan's own self-hosted target">CFMAN SELF</span><button className="button button-secondary button-small publication-reconcile-button" type="button" title="Check and fix CFMan's own remote-agent routes and merged WAF rule for this hostname" disabled={reconcileCfmanSelf.isPending} onClick={() => reconcileCfmanSelf.mutate()}><RefreshCw size={14} className={reconcileCfmanSelf.isPending ? "spin-icon" : undefined} />{reconcileCfmanSelf.isPending ? "Reconciling..." : "Reconcile"}</button></>}<StatusBadge status={publication.status} /></div>{publication.routes.map((route) => { const isSshRoute = route.serviceUrl.startsWith("ssh://"); return <div className="publication-route" key={route.id}><code>{route.path}</code><span>→</span><code>{route.kind === "command_agent" ? "CFMan command agent" : isSshRoute ? `SSH ${route.serviceUrl.replace("ssh://", "")}` : route.serviceUrl}</code><div className="publication-route-actions">{!isSshRoute && <button className="button button-secondary publication-verify-button" type="button" onClick={() => verify.mutate(route.id)} disabled={verify.isPending}><CheckCircle2 size={15} />{verify.isPending && verify.variables === route.id ? "Checking..." : "Verify endpoint"}</button>}<button className={`button button-secondary publication-waf-button ${route.wafEnabled && route.wafRuleId ? "waf-active" : ""}`} type="button" title={route.wafEnabled && !route.wafRuleId ? "WAF policy is pending application" : "Manage route WAF"} onClick={() => setWafRoute(route)}><ShieldCheck size={15} />WAF</button></div></div>; })}</div>)}</section>}
        </div>}
        {tab === "connect" && <div className="tunnel-drawer-tab tunnel-connect-tab">
          {drawerHostPlatform === "windows" && <section className="tunnel-drawer-section rdp-section">
            <header className="tunnel-section-heading"><div><h3>Remote desktop</h3><span>{currentTunnel.rdpUrl ? new URL(currentTunnel.rdpUrl).hostname : "Browser RDP gateway"}</span></div><StatusBadge status={currentTunnel.rdpStatus} /></header>
            <div className="rdp-connection-row">
              <div className="rdp-connection-item"><span className="rdp-connection-label">Target</span><code className="rdp-connection-value" title={currentTunnel.rdpTargetIp ? `${currentTunnel.rdpTargetIp}:3389` : "Not enabled yet"}>{currentTunnel.rdpTargetIp ? `${currentTunnel.rdpTargetIp}:3389` : "Not enabled yet"}</code></div>
              <div className="rdp-connection-item"><span className="rdp-connection-label">Gateway</span><code className="rdp-connection-value" title={currentTunnel.rdpUrl ?? "Not provisioned"}>{currentTunnel.rdpUrl ?? "Not provisioned"}</code></div>
              <div className="rdp-connection-action">{currentTunnel.rdpStatus === "ready" && currentTunnel.rdpUrl && <a className="button button-primary" href={currentTunnel.rdpUrl} target="_blank" rel="noreferrer"><MonitorUp size={16} />Remote desktop</a>}{currentTunnel.rdpTargetIp && currentTunnel.rdpStatus !== "ready" && <button className="button button-secondary" onClick={() => retryRdp.mutate()} disabled={retryRdp.isPending}><RefreshCw size={15} />{retryRdp.isPending ? "Retrying..." : "Retry RDP"}</button>}{!currentTunnel.rdpTargetIp && <button className="button button-secondary" onClick={() => enableRds.mutate()} disabled={enableRds.isPending}><MonitorUp size={15} />{enableRds.isPending ? "Enabling..." : "Enable RDS"}</button>}</div>
            </div>
            {currentTunnel.rdpLastError && <div className="inline-alert">{currentTunnel.rdpLastError}</div>}
          </section>}
          {drawerHostPlatform === "unix" && <section className="tunnel-drawer-section rdp-section ssh-section">
            <header className="tunnel-section-heading"><div><h3>SSH</h3><span>{currentTunnel.sshUrl ? new URL(currentTunnel.sshUrl).hostname : "Browser SSH gateway"}</span></div><StatusBadge status={currentTunnel.sshStatus} /></header>
            <div className="rdp-connection-row">
              <div className="rdp-connection-item"><span className="rdp-connection-label">Target</span><code className="rdp-connection-value" title={sshRoute ? `${currentTunnel.sshUsername ?? "root"}@${sshRoute.serviceUrl.replace("ssh://", "")}` : "Not enabled yet"}>{sshRoute ? `${currentTunnel.sshUsername ?? "root"}@${sshRoute.serviceUrl.replace("ssh://", "")}` : "Not enabled yet"}</code></div>
              <div className="rdp-connection-item"><span className="rdp-connection-label">Gateway</span><code className="rdp-connection-value" title={currentTunnel.sshUrl ?? "Not provisioned"}>{currentTunnel.sshUrl ?? "Not provisioned"}</code></div>
              <div className="rdp-connection-action">{currentTunnel.sshStatus === "ready" && currentTunnel.sshUrl && <a className="button button-primary" href={currentTunnel.sshUrl} target="_blank" rel="noreferrer"><TerminalSquare size={16} />Browser SSH</a>}{sshRoutePublication && currentTunnel.sshStatus !== "ready" && <button className="button button-secondary" onClick={() => retrySsh.mutate()} disabled={retrySsh.isPending}><RefreshCw size={15} />{retrySsh.isPending ? "Retrying..." : "Retry SSH"}</button>}{!sshRoutePublication && <button className="button button-secondary" onClick={() => setEnableSshOpen(true)}><TerminalSquare size={15} />Enable SSH</button>}</div>
            </div>
            {sshRoutePublication && <div className="inline-note"><TerminalSquare size={14} /><span>Direct route, using whatever SSH key or password is already authorized on the target machine:<div className="inline-note-code-row"><code>{sshDirectRouteCommand}</code><CopyButton value={sshDirectRouteCommand} label="Copy SSH command" iconOnly /></div></span></div>}
            {currentTunnel.sshLastError && <div className="inline-alert">{currentTunnel.sshLastError}</div>}
          </section>}
          {!drawerHostPlatform && <div className="inline-note"><ShieldCheck size={15} />Remote desktop or SSH access appears here automatically once a Windows or Linux enrollment finishes installing.</div>}
          {currentTunnel.commandAgent ? <CommandExecutionPanel tunnel={currentTunnel} /> : <div className="inline-alert">This tunnel does not have a command agent endpoint.</div>}
        </div>}
      </div>}
    </SideDrawer>
    <UnenrollDialog enrollment={unenrollTarget} commandAgent={currentTunnel?.commandAgent ?? null} automatic={automaticUnenroll} onAutomaticChange={setAutomaticUnenroll} onClose={() => setUnenrollTarget(null)} onConfirm={() => unenrollTarget && issueUnenrollment.mutate({ enrollmentId: unenrollTarget.id, automatic: automaticUnenroll })} submitting={issueUnenrollment.isPending} />
    <EnrollmentDeleteDialog enrollment={deleteEnrollmentTarget} onClose={() => setDeleteEnrollmentTarget(null)} onConfirm={() => deleteEnrollmentTarget && deleteEnrollment.mutate(deleteEnrollmentTarget.id)} deleting={deleteEnrollment.isPending} />
    <TunnelDeleteDialog open={deleteOpen} preflight={deletePreflight} loading={deletePreflightMutation.isPending} confirmationName={deleteName} onConfirmationNameChange={setDeleteName} onClose={() => { setDeleteOpen(false); setDeletePreflight(null); setDeleteName(""); }} onConfirm={() => deleteTunnel.mutate()} deleting={deleteTunnel.isPending} />
    <RouteWafDialog tunnel={currentTunnel ?? null} route={wafRoute} onClose={() => setWafRoute(null)} />
    {currentTunnel && <EnableSshDialog tunnel={currentTunnel} open={enableSshOpen} onClose={() => setEnableSshOpen(false)} />}
    {currentTunnel && <TroubleshootDialog tunnel={currentTunnel} open={troubleshootOpen} onClose={() => setTroubleshootOpen(false)} onManageWaf={(route) => { setTroubleshootOpen(false); setWafRoute(route); }} />}
    <ReassignZoneDialog open={reassigningZone} currentZoneId={currentTunnel?.zoneId ?? null} onClose={() => setReassigningZone(false)} onConfirm={(zoneId) => reassignZone.mutate(zoneId)} submitting={reassignZone.isPending} />
    <TunnelVariablesModal tunnel={currentTunnel ?? null} open={tunnelVariablesOpen} onClose={() => setTunnelVariablesOpen(false)} />
    </>
  );
}

function TunnelDeleteDialog({
  open,
  preflight,
  loading,
  confirmationName,
  onConfirmationNameChange,
  onClose,
  onConfirm,
  deleting
}: {
  open: boolean;
  preflight: TunnelDeletePreflight | null;
  loading: boolean;
  confirmationName: string;
  onConfirmationNameChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
}) {
  const requiresName = Boolean(preflight && !preflight.canDelete);
  const nameMatches = !requiresName || confirmationName === preflight?.displayName;
  return <Modal open={open} title={`Delete tunnel · ${preflight?.displayName ?? "Tunnel"}`} onClose={onClose} width="wide">
    {loading || !preflight ? <div className="quiet-empty">Checking deletion readiness...</div> : <div className="delete-confirmation">
      <p>This permanently removes the tunnel from CFMan and attempts to delete its tunnel-owned Cloudflare DNS, tunnel, and RDP network resources.</p>
      <div className="delete-check-list">{preflight.checks.map((check) => <article className={`delete-check-row ${check.ok ? "delete-check-ok" : "delete-check-blocked"}`} key={check.id}><span className="delete-check-icon">{check.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}</span><div><strong>{check.label}</strong><p>{check.detail}</p><small><b>How to resolve:</b> {check.resolution}</small></div></article>)}</div>
      {requiresName && <div className="delete-force-panel"><div className="inline-alert"><AlertTriangle size={15} />One or more safety checks are not ready. Force delete will terminate remaining tunnel connections and may interrupt running commands.</div><label className="field"><span className="field-label">Type the tunnel name to confirm <FieldHelp text="Enter the exact display name shown in the tunnel details title. This extra confirmation is required when a tunnel, enrollment, or command is still active." /></span><input value={confirmationName} onChange={(event) => onConfirmationNameChange(event.target.value)} placeholder={preflight.displayName} autoComplete="off" /></label></div>}
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-danger" type="button" disabled={!nameMatches || deleting} onClick={onConfirm}><Trash2 size={15} />{deleting ? "Deleting..." : requiresName ? "Force delete tunnel" : "Delete tunnel"}</button></div>
    </div>}
  </Modal>;
}

function EnrollmentDeleteDialog({ enrollment, onClose, onConfirm, deleting }: { enrollment: TunnelEnrollment | null; onClose: () => void; onConfirm: () => void; deleting: boolean }) {
  return <Modal open={Boolean(enrollment)} title={enrollment ? <span className="host-identity"><HostPlatformIcon environment={enrollment.environment} platform={enrollment.platform} osName={enrollment.hostInfo.osName} /><span>Delete enrollment · {enrollmentComputerName(enrollment)}</span></span> : "Delete enrollment"} onClose={onClose}>
    <div className="enrollment-delete-dialog">
      <div className="inline-alert enrollment-delete-no-logs"><Trash2 size={15} />This permanently deletes the enrollment. Its logs will no longer be available to view.</div>
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-danger" type="button" onClick={onConfirm} disabled={deleting}><Trash2 size={15} />{deleting ? "Deleting..." : "Delete permanently"}</button></div>
    </div>
  </Modal>;
}

function UnenrollDialog({ enrollment, commandAgent, automatic, onAutomaticChange, onClose, onConfirm, submitting }: {
  enrollment: TunnelEnrollment | null;
  commandAgent: Tunnel["commandAgent"];
  automatic: boolean;
  onAutomaticChange: (value: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  const automaticAvailable = Boolean(commandAgent?.status === "ready" && enrollment?.platform);
  return <Modal open={Boolean(enrollment)} title={enrollment ? <span className="host-identity"><HostPlatformIcon environment={enrollment.environment} platform={enrollment.platform} osName={enrollment.hostInfo.osName} /><span>Unenroll · {enrollmentComputerName(enrollment)}</span></span> : "Unenroll"} onClose={onClose}>
    <div className="enrollment-delete-dialog">
      <p>CFMan will revoke this enrollment only after its local services and all tunnel-owned Cloudflare routes, DNS records, RDP resources, and tunnel have been cleaned up.</p>
      <label className={`checkbox-field ${automaticAvailable ? "" : "disabled"}`}>
        <input type="checkbox" checked={automatic && automaticAvailable} disabled={!automaticAvailable} onChange={(event) => onAutomaticChange(event.target.checked)} />
        <span><strong>Run automatically through command agent</strong><small>{automaticAvailable ? `Send a detached cleanup task to ${commandAgent?.endpoint}. Manual commands remain available as fallback.` : "The connected enrollment needs a ready command agent and a detected platform."}</small></span>
      </label>
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-danger" type="button" onClick={onConfirm} disabled={submitting}><Unplug size={15} />{submitting ? "Unenrolling..." : automatic && automaticAvailable ? "Unenroll automatically" : "Issue cleanup command"}</button></div>
    </div>
  </Modal>;
}

function ReassignZoneDialog({ open, currentZoneId, onClose, onConfirm, submitting }: { open: boolean; currentZoneId: string | null; onClose: () => void; onConfirm: (zoneId: string) => void; submitting: boolean }) {
  const [zoneId, setZoneId] = useState("");
  const { data } = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<{ accounts: CloudflareAccount[] }>("/api/accounts"), enabled: open });
  useEffect(() => { if (open) setZoneId(""); }, [open]);
  const zoneOptions = [
    { value: "", label: "Select account / zone" },
    ...(data?.accounts.flatMap((account) => account.zones
      .filter((zone) => account.status === "active" && zone.status === "active" && zone.id !== currentZoneId)
      .map((zone) => ({ value: zone.id, label: `${account.name} / ${zone.name} · ${zone.tunnelCount}/${zone.softTunnelLimit}` }))) ?? [])
  ];
  return <Modal open={open} title="Change account/zone" onClose={onClose}>
    <div className="form-stack">
      <div className="inline-alert"><AlertTriangle size={15} />This regenerates every published hostname for this tunnel using the new zone's domain. Only available because the tunnel has no active enrollment and has been fully unenrolled.</div>
      <label className="field"><span className="field-label">New account / zone</span><SearchableSelect name="reassignZoneId" options={zoneOptions} value={zoneId} ariaLabel="New account and zone assignment" emptyMessage="No matching account or zone" onValueChange={setZoneId} /></label>
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" disabled={!zoneId || submitting} onClick={() => onConfirm(zoneId)}>{submitting ? "Updating..." : "Change account/zone"}</button></div>
    </div>
  </Modal>;
}

function EnrollmentHistory({ tunnelId, enrollments, pagination, autoExpandId, onPageChange, onDelete, onUnenroll, deleting, unenrolling }: { tunnelId: string; enrollments: TunnelEnrollment[]; pagination?: { page: number; pageSize: number; total: number; totalPages: number } | undefined; autoExpandId: string | null; onPageChange: (page: number) => void; onDelete: (enrollment: TunnelEnrollment) => void; onUnenroll: (enrollment: TunnelEnrollment) => void; deleting: boolean; unenrolling: boolean }) {
  const [expandedId, setExpandedId] = useState<string | null>(autoExpandId);
  useEffect(() => { if (autoExpandId) setExpandedId(autoExpandId); }, [autoExpandId]);
  useEffect(() => { setExpandedId(null); }, [pagination?.page]);
  const total = pagination?.total ?? enrollments.length;
  return <section className="enrollment-history"><header><h3>Enrollment history</h3><span>{total} attempt{total === 1 ? "" : "s"}</span></header>{enrollments.length ? <div className="enrollment-history-list">{enrollments.map((enrollment) => {
    const environment = enrollmentEnvironment(enrollment);
    const displayStatus = enrollmentDisplayStatus(enrollment);
    const displayTime = enrollmentDisplayTime(enrollment, displayStatus);
    const isOpen = expandedId === enrollment.id;
    return <details className="enrollment-history-row" key={enrollment.id} open={isOpen} onToggle={(event) => { if (event.currentTarget.open) setExpandedId(enrollment.id); else if (expandedId === enrollment.id) setExpandedId(null); }}>
      <summary>
        <div className="enrollment-history-field enrollment-computer-field"><div className="enrollment-computer-summary" title={environment} aria-label={`${environment} · ${enrollmentComputerName(enrollment)}`}><span className="enrollment-platform-icon"><HostPlatformIcon environment={enrollment.environment} platform={enrollment.platform} osName={enrollment.hostInfo.osName} size={19} /></span><strong>{enrollmentComputerName(enrollment)}</strong></div></div>
        <div className="enrollment-history-field enrollment-status-cell"><StatusBadge status={displayStatus} /></div>
        <time className="enrollment-event-time" dateTime={displayTime ?? undefined}>{displayTime ? new Date(displayTime).toLocaleString() : "-"}</time>
        <div className="enrollment-history-actions">{enrollment.isCurrent ? <button className="icon-button enrollment-unenroll-button" type="button" title="Unenroll this computer" aria-label={`Unenroll ${enrollmentComputerName(enrollment)}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onUnenroll(enrollment); }} disabled={unenrolling}><Unplug size={16} /></button> : !enrollment.deletedAt ? <button className="icon-button enrollment-delete-button" type="button" title="Delete enrollment permanently" aria-label={`Delete enrollment for ${enrollmentComputerName(enrollment)}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDelete(enrollment); }} disabled={deleting}><Trash2 size={15} /></button> : <span className="enrollment-action-placeholder" aria-hidden="true" />}</div>
      </summary>
      {isOpen && <div className="enrollment-history-body"><EnrollmentHistoryBody tunnelId={tunnelId} enrollment={enrollment} status={displayStatus} onDelete={onDelete} deleting={deleting} /></div>}
    </details>;
  })}</div> : <div className="quiet-empty">No enrollment links have been issued for this tunnel.</div>}{pagination && pagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous enrollment page" aria-label="Previous enrollment page" disabled={pagination.page <= 1} onClick={() => onPageChange(Math.max(1, pagination.page - 1))}><ChevronLeft size={15} /></button><span>Page {pagination.page} of {pagination.totalPages}</span><button className="icon-button" type="button" title="Next enrollment page" aria-label="Next enrollment page" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)}><ChevronRight size={15} /></button></div>}</section>;
}

function EnrollmentHistoryBody({ tunnelId, enrollment, status, onDelete, deleting }: { tunnelId: string; enrollment: TunnelEnrollment; status: string; onDelete: (enrollment: TunnelEnrollment) => void; deleting: boolean }) {
  if (status === "staled") {
    return <div className="enrollment-history-expired">
      <div className="inline-alert"><AlertTriangle size={15} />This enrollment link expired before it was ever used. It's safe to delete.</div>
      <div className="form-actions"><button className="button button-danger" type="button" onClick={() => onDelete(enrollment)} disabled={deleting}><Trash2 size={15} />{deleting ? "Deleting..." : "Delete enrollment"}</button></div>
    </div>;
  }
  if (status === "never_run" || status === "running") {
    return <>
      <EnrollmentScriptPanel tunnelId={tunnelId} enrollmentId={enrollment.id} expiresAt={enrollment.expiresAt} defaultPlatform={enrollment.platform === "unix" ? "unix" : "windows"} />
      {status === "running" && <>
        <div className="enrollment-run-info"><strong>Started</strong> {new Date(enrollment.claimedAt ?? enrollment.createdAt).toLocaleString()}</div>
        <EnrollmentLogPanel tunnelId={tunnelId} enrollmentId={enrollment.id} live />
      </>}
    </>;
  }
  return <>
    {(status === "unenroll_pending" || status === "unenroll_failed") && <UnenrollHelperPanel tunnelId={tunnelId} enrollment={enrollment} status={status} />}
    {enrollment.isCurrent && <ComputerVariablesPanel tunnelId={tunnelId} enrollment={enrollment} />}
    <EnrollmentLogPanel tunnelId={tunnelId} enrollmentId={enrollment.id} live={status === "unenroll_pending"} />
  </>;
}

function ComputerVariablesPanel({ tunnelId, enrollment }: { tunnelId: string; enrollment: TunnelEnrollment }) {
  const queryClient = useQueryClient();
  const [variables, setVariables] = useState<ExecutionVariables>(enrollment.executionVariables ?? {});
  useEffect(() => setVariables(enrollment.executionVariables ?? {}), [enrollment.id, enrollment.executionVariables]);
  const mutation = useMutation({
    mutationFn: () => api.put(`/api/tunnels/${tunnelId}/enrollments/${enrollment.id}/execution-variables`, { variables }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-enrollments", tunnelId] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnelId] })
      ]);
      toast.success("Computer variables updated");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update computer variables")
  });
  return <section className="computer-variable-panel"><header><div><h4>Computer variables</h4><span>Applied while this computer is the active enrollment.</span></div></header><ExecutionVariablesEditor variables={variables} savedVariables={enrollment.executionVariables ?? {}} onChange={setVariables} /><div className="form-actions"><AddVariableButton variables={variables} onChange={setVariables} small /><button className="button button-primary button-small" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}><Save size={14} />{mutation.isPending ? "Saving..." : "Save variables"}</button></div></section>;
}

function TunnelVariablesModal({ tunnel, open, onClose }: { tunnel: Tunnel | null; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [variables, setVariables] = useState<ExecutionVariables>({});
  useEffect(() => { if (open) setVariables(tunnel?.executionVariables ?? {}); }, [open, tunnel?.id, tunnel?.executionVariables]);
  const mutation = useMutation({
    mutationFn: () => api.put(`/api/tunnels/${tunnel!.id}/execution-variables`, { variables }),
    onSuccess: async () => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel?.id] }), queryClient.invalidateQueries({ queryKey: ["tunnels"] })]);
      toast.success("Tunnel variables updated");
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update tunnel variables")
  });
  return <Modal open={open && Boolean(tunnel)} title={<>Environment variables · <span className="scope-badge">Tunnel</span> · {tunnel?.displayName ?? "tunnel"}</>} onClose={onClose}><div className="form-stack"><ExecutionVariablesEditor variables={variables} savedVariables={tunnel?.executionVariables ?? {}} onChange={setVariables} builtIns={["TENANT_CODE", "TUNNEL_NAME", "TUNNEL_CODE"]} /><div className="built-in-variable-note"><strong>Built-ins</strong><code>TENANT_CODE</code><code>TUNNEL_NAME</code><code>TUNNEL_CODE</code></div><div className="form-actions"><button className="button button-secondary cancel-button-left" type="button" onClick={onClose}>Cancel</button><AddVariableButton variables={variables} onChange={setVariables} /><button className="button button-primary" type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? "Saving..." : "Save variables"}</button></div></div></Modal>;
}

function EnrollmentScriptPanel({ tunnelId, enrollmentId, expiresAt, defaultPlatform }: { tunnelId: string; enrollmentId: string; expiresAt: string; defaultPlatform: "windows" | "unix" }) {
  const { data, isLoading } = useQuery({
    queryKey: ["enrollment-install-script", tunnelId, enrollmentId],
    queryFn: () => api.get<{ powershell: string | null; shell: string | null }>(`/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/install-script`),
    enabled: Boolean(tunnelId && enrollmentId)
  });
  if (isLoading) return <div className="quiet-empty">Loading install link...</div>;
  if (!data?.powershell && !data?.shell) return <div className="quiet-empty">The install link is not available for this enrollment.</div>;
  return <EnrollmentCommands result={{ id: enrollmentId, expiresAt, urls: { powershell: data.powershell ?? "", shell: data.shell ?? "" } }} defaultPlatform={defaultPlatform} />;
}

type EnrollmentLogEntry = { id: number; level: string; step: string | null; message: string; metadata: Record<string, unknown>; phase: "enroll" | "unenroll" | "diagnostic"; diagnosticRunId: string | null; createdAt: string };
type DiagnosticRun = { id: string; platform: "windows" | "unix" | null; status: "pending" | "running" | "completed" | "failed"; expiresAt: string; createdAt: string; startedAt: string | null; finishedAt: string | null };
type EnrollmentLogResponse = { logs: EnrollmentLogEntry[]; diagnosticRuns: DiagnosticRun[]; hasActiveDiagnostics: boolean };

function EnrollmentLogList({ logs, emptyLabel }: { logs: EnrollmentLogEntry[]; emptyLabel: string }) {
  if (!logs.length) return <div className="quiet-empty">{emptyLabel}</div>;
  return <div className="enrollment-log-list">{logs.map((log) => <article key={log.id} className={`enrollment-log enrollment-log-${log.level}`}><header><StatusBadge status={log.level} /><strong>{log.step ?? "installer"}</strong><time>{new Date(log.createdAt).toLocaleString()}</time></header><p>{log.message}</p></article>)}</div>;
}

function EnrollmentLogPanel({ tunnelId, enrollmentId, live }: { tunnelId: string; enrollmentId: string; live: boolean }) {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["enrollment-logs", tunnelId, enrollmentId],
    queryFn: () => api.get<EnrollmentLogResponse>(`/api/tunnels/${tunnelId}/enrollments/${enrollmentId}/logs`),
    enabled: Boolean(tunnelId && enrollmentId),
    refetchInterval: (query) => live || query.state.data?.hasActiveDiagnostics ? 2000 : false
  });
  const refreshButton = <button className="icon-button" type="button" title="Refresh enrollment and unenrollment logs" aria-label="Refresh enrollment and unenrollment logs" disabled={isFetching} onClick={() => void refetch()}><RefreshCw size={14} className={isFetching ? "spin-icon" : undefined} /></button>;
  if (isLoading) return <div className="enrollment-log-panel"><div className="enrollment-log-toolbar">{refreshButton}</div><div className="quiet-empty">Loading logs...</div></div>;
  const logs = data?.logs ?? [];
  const diagnosticRuns = data?.diagnosticRuns ?? [];
  if (!logs.length && !diagnosticRuns.length) return <div className="enrollment-log-panel"><div className="enrollment-log-toolbar">{refreshButton}</div><div className="quiet-empty">No logs have been reported for this enrollment.</div></div>;
  const enrollLogs = logs.filter((log) => log.phase === "enroll");
  const unenrollLogs = logs.filter((log) => log.phase === "unenroll");
  const diagnosticLogs = logs.filter((log) => log.phase === "diagnostic");
  return <div className="enrollment-log-panel"><div className="enrollment-log-toolbar">{refreshButton}</div><div className="enrollment-log-sections">
    <section className="enrollment-log-section"><h4>Enrollment</h4><EnrollmentLogList logs={enrollLogs} emptyLabel="No enrollment logs have been reported." /></section>
    <section className="enrollment-log-section"><h4>Unenrollment</h4><EnrollmentLogList logs={unenrollLogs} emptyLabel="No unenrollment logs have been reported." /></section>
    <section className="enrollment-log-section"><h4>Diagnostic</h4>{diagnosticRuns.length ? <div className="diagnostic-run-list">{diagnosticRuns.map((run) => <section className="diagnostic-run" key={run.id}>
      <header><div><strong>{new Date(run.createdAt).toLocaleString()}</strong><span>{run.platform ?? "Awaiting platform"}</span></div><StatusBadge status={run.status} /></header>
      <EnrollmentLogList logs={diagnosticLogs.filter((log) => log.diagnosticRunId === run.id)} emptyLabel={run.status === "pending" ? "Waiting for the diagnostic script to start." : run.status === "running" ? "Diagnostic script is running and has not reported results yet." : "No diagnostic results were reported."} />
    </section>)}</div> : <div className="quiet-empty">No diagnostic runs have been reported.</div>}</section>
  </div></div>;
}

function enrollmentComputerName(enrollment: TunnelEnrollment): string {
  return enrollment.computerName ?? enrollment.hostInfo.machineName ?? "N/A";
}

function enrollmentRunStatus(enrollment: TunnelEnrollment): "never_run" | "running" | "success" | "failed" {
  const installScripts = enrollment.scripts.filter((script) => script.kind === "install");
  if (installScripts.some((script) => script.status === "failed") || enrollment.status === "failed") return "failed";
  if (installScripts.some((script) => script.status === "running") || ["claimed", "provisioning", "ready"].includes(enrollment.status)) return "running";
  if (installScripts.some((script) => script.status === "completed") || enrollment.status === "installed") return "success";
  return "never_run";
}

function enrollmentDisplayStatus(enrollment: TunnelEnrollment): string {
  if (enrollment.deletedAt) return "deleted";
  // Checked before isCurrent: the current enrollment stays isCurrent=true for
  // the entire time an unenroll is pending or has failed (unenrolled_at only
  // gets set once cleanup actually completes), so those states must win over
  // the "active" shortcut or a pending/failed unenroll would be invisible.
  if (enrollment.unenrollStatus === "unenrolled") return "unenrolled";
  if (enrollment.unenrollStatus === "failed") return "unenroll_failed";
  if (enrollment.unenrollStatus === "pending") return "unenroll_pending";
  if (enrollment.isCurrent) return "active";
  if (enrollmentRunStatus(enrollment) === "never_run" && (enrollment.status === "expired" || new Date(enrollment.expiresAt).getTime() <= Date.now())) return "staled";
  return enrollmentRunStatus(enrollment);
}

function enrollmentDisplayTime(enrollment: TunnelEnrollment, status: string): string | null {
  if (status === "deleted") return enrollment.deletedAt;
  if (status === "active") return enrollment.installedAt ?? enrollment.claimedAt ?? enrollment.createdAt;
  if (status === "unenrolled") return enrollment.unenrolledAt;
  if (status === "unenroll_pending" || status === "unenroll_failed") return enrollment.unenrollRequestedAt;
  if (status === "never_run" || status === "staled") return enrollment.createdAt;
  if (status === "running") return enrollment.claimedAt ?? enrollment.createdAt;
  if (status === "success") return enrollment.installedAt ?? enrollment.createdAt;
  const finishedScript = enrollment.scripts.find((script) => script.status === "failed" && script.finishedAt);
  return finishedScript?.finishedAt ?? enrollment.claimedAt ?? enrollment.createdAt;
}

function enrollmentEnvironment(enrollment: TunnelEnrollment): string {
  switch (enrollment.environment ?? enrollment.platform) {
    case "windows": return "Windows";
    case "linux": return "Linux";
    case "darwin": return "macOS";
    case "unix": return "Unix";
    default: return "Not detected";
  }
}

type CommandExecutionResult = {
  executionId: string;
  endpoint: string;
  enrollmentId: string;
  scriptType: "managed" | "inline";
  scriptId: string | null;
  scriptVersionId: string | null;
  scriptName: string;
  version: number | null;
  platform: "windows" | "unix";
  language: "powershell" | "bash" | "sh";
  taskId: string;
  status: TunnelCommandExecution["status"];
  scheduled: boolean;
  success?: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
};

type CommandExecutionPage = {
  executions: TunnelCommandExecution[];
  summary: ExecutionStats;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

const quickScriptDefaults = {
  windows: "Write-Output \"Tunnel: $env:COMPUTERNAME\"\n",
  unix: "printf 'Tunnel: %s\\n' \"$(hostname)\"\n"
};

// A name is required before Execute enables, but requiring the operator to
// type one before they can run a quick one-off script means they see working
// code with a disabled button. Deriving a default from the script's first
// meaningful line - stripped of shebang/comment markers, cut at a word
// boundary rather than mid-word - keeps the field populated (and still
// editable) without ever blocking on it.
function deriveInlineScriptName(content: string): string {
  const firstLine = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  const stripped = firstLine.replace(/^#!.*$/, "").replace(/^(#|\/\/)+\s*/, "").trim();
  const candidate = stripped || firstLine;
  const maxLength = 60;
  if (candidate.length <= maxLength) return candidate;
  const truncated = candidate.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated}…`;
}

function ArgumentSummary({ argumentsList, data, loading, error }: { argumentsList: ScriptArgument[]; data: { availableVariables: ExecutionVariables } | undefined; loading: boolean; error: unknown }) {
  if (loading) return <div className="quiet-empty">Resolving available variables...</div>;
  if (error) return <div className="inline-alert">{error instanceof Error ? error.message : "Unable to resolve available variables"}</div>;
  if (!data) return null;
  const variableCount = Object.keys(data.availableVariables).length;
  const requiredNames = argumentsList.filter((argument) => argument.required).map((argument) => argument.name);
  return <div className="argument-summary-hint">{argumentsList.length} argument{argumentsList.length === 1 ? "" : "s"} declared{requiredNames.length ? ` (required: ${requiredNames.join(", ")})` : ""} · {variableCount} variable{variableCount === 1 ? "" : "s"} available to map · configure on Execute</div>;
}

function CommandExecutionPanel({ tunnel }: { tunnel: Tunnel }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openScriptDrawer } = useDrawers();
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [executionMode, setExecutionMode] = useState<"saved" | "inline">("saved");
  const [inlineName, setInlineName] = useState("");
  const [inlineNameTouched, setInlineNameTouched] = useState(false);
  const [inlineContent, setInlineContent] = useState(quickScriptDefaults.windows);
  const [inlineLanguage, setInlineLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [inlineArguments, setInlineArguments] = useState<import("../types").ScriptArgument[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historySearch, setHistorySearch] = useState("");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [expandedExecutionId, setExpandedExecutionId] = useState<string | null>(null);
  const [expandLatestAfterExecution, setExpandLatestAfterExecution] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickLanguage, setQuickLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [quickDescription, setQuickDescription] = useState("");
  const [quickTimeoutSeconds, setQuickTimeoutSeconds] = useState(60);
  const [quickContent, setQuickContent] = useState(quickScriptDefaults.windows);
  const [quickArguments, setQuickArguments] = useState<import("../types").ScriptArgument[]>([]);
  const [executeConfirmOpen, setExecuteConfirmOpen] = useState(false);
  const [argumentBindings, setArgumentBindings] = useState<ArgumentBindings>({});
  const hostPlatform = activeEnrollmentPlatform(tunnel);
  const historyPageSize = 10;
  const historyParams = new URLSearchParams({ page: String(historyPage), pageSize: String(historyPageSize) });
  if (historySearch.trim()) historyParams.set("search", historySearch.trim());
  if (historyFrom) historyParams.set("from", new Date(historyFrom).toISOString());
  if (historyTo) historyParams.set("to", new Date(historyTo).toISOString());
  const { data: executionData } = useQuery({
    queryKey: ["command-executions", tunnel.id, historySearch.trim(), historyFrom, historyTo, historyPage, historyPageSize],
    queryFn: () => api.get<CommandExecutionPage>(`/api/tunnels/${tunnel.id}/command-executions?${historyParams.toString()}`),
    refetchInterval: (query) => query.state.data?.summary && (query.state.data.summary.scheduled > 0 || query.state.data.summary.running > 0) ? 2000 : false
  });
  const { data: scriptData } = useQuery({
    queryKey: ["scripts", "command-agent", hostPlatform],
    queryFn: () => api.get<{ scripts: ManagedScriptSummary[] }>(`/api/scripts?${new URLSearchParams({ ...(hostPlatform ? { platform: hostPlatform } : {}), pageSize: "100" })}`),
    enabled: Boolean(hostPlatform)
  });
  const { data: selectedScriptData } = useQuery({
    queryKey: ["script-detail", selectedScriptId],
    queryFn: () => api.get<{ script: ManagedScript }>(`/api/scripts/${selectedScriptId}`),
    enabled: Boolean(selectedScriptId)
  });
  const selectedScript = selectedScriptData?.script;
  const selectedScriptVersion = selectedScript?.versions.find((version) => version.id === selectedVersionId) ?? selectedScript?.versions[0];
  const { data: resolvedVariableData, isLoading: variablesLoading, isError: variablesErrored, error: variablesError, refetch: refetchVariables } = useQuery({
    queryKey: ["resolved-execution-variables", tunnel.id, executionMode, selectedVersionId],
    queryFn: () => api.post<{ arguments: ScriptArgument[]; availableVariables: ExecutionVariables; sources: Record<string, string> }>(`/api/tunnels/${tunnel.id}/execution-variables/resolve`, executionMode === "saved" ? { scriptVersionId: selectedVersionId } : {}),
    enabled: executionMode === "inline" || Boolean(selectedVersionId)
  });
  const scriptOptions = scriptData?.scripts ?? [];
  const pickerOptions = scriptOptions.map((script) => ({ value: script.id, label: `${script.name} · ${script.platform}` }));
  useEffect(() => {
    if (selectedScript && selectedScript.versions[0] && !selectedScript.versions.some((version) => version.id === selectedVersionId)) setSelectedVersionId(selectedScript.versions[0].id);
  }, [selectedScript, selectedVersionId]);
  useEffect(() => {
    if (executionMode === "saved" && selectedScript) setTimeoutSeconds(Math.round(selectedScript.defaultTimeoutMs / 1000));
  }, [executionMode, selectedScript]);
  useEffect(() => {
    if (!hostPlatform) return;
    const language = hostPlatform === "windows" ? "powershell" : "bash";
    setInlineLanguage(language);
    setInlineName(deriveInlineScriptName(quickScriptDefaults[hostPlatform]));
    setInlineNameTouched(false);
    setInlineContent(quickScriptDefaults[hostPlatform]);
    setInlineArguments([]);
    setSelectedScriptId("");
    setSelectedVersionId("");
    setTimeoutSeconds(60);
    setExecutionMode("saved");
    setHistoryPage(1);
    setHistorySearch("");
    setHistoryFrom("");
    setHistoryTo("");
    setExpandedExecutionId(null);
  }, [hostPlatform, tunnel.id]);
  useEffect(() => {
    if (inlineNameTouched) return;
    setInlineName(deriveInlineScriptName(inlineContent));
  }, [inlineContent, inlineNameTouched]);
  useEffect(() => {
    setHistoryPage(1);
    setExpandedExecutionId(null);
  }, [historySearch, historyFrom, historyTo]);
  const openQuickCreate = () => {
    if (!hostPlatform) return;
    setQuickName("");
    setQuickDescription("");
    setQuickTimeoutSeconds(60);
    setQuickLanguage(hostPlatform === "windows" ? "powershell" : "bash");
    setQuickContent(quickScriptDefaults[hostPlatform]);
    setQuickArguments([]);
    setQuickCreateOpen(true);
  };
  const quickCreate = useMutation({
    mutationFn: () => api.post<{ id: string; versionId: string }>("/api/scripts", {
      name: quickName,
      platform: hostPlatform,
      language: quickLanguage,
      description: quickDescription,
      defaultTimeoutMs: quickTimeoutSeconds * 1000,
      content: quickContent,
      arguments: quickArguments
    }),
    onSuccess: async (created) => {
      setQuickCreateOpen(false);
      setSelectedScriptId(created.id);
      setSelectedVersionId(created.versionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["script-detail", created.id] })
      ]);
      toast.success("Quick script created");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to create script")
  });
  const execute = useMutation({
    mutationFn: (bindings: ArgumentBindings) => api.post<CommandExecutionResult>(`/api/tunnels/${tunnel.id}/commands/execute`, {
      ...(executionMode === "saved"
        ? { scriptVersionId: selectedVersionId }
        : { inlineScript: inlineContent, name: inlineName, language: inlineLanguage, arguments: inlineArguments }),
      timeoutMs: timeoutSeconds * 1_000,
      argumentBindings: bindings
    }),
    onSuccess: async (response) => {
      setExecuteConfirmOpen(false);
      setHistoryPage(1);
      setExpandedExecutionId(response.executionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions", tunnel.id] }),
        queryClient.invalidateQueries({ queryKey: ["tunnels"] })
      ]);
      setExpandLatestAfterExecution(false);
      if (response.scheduled) toast.success("Script scheduled");
      else if (response.success) toast.success("Script completed successfully");
      else toast.error(`Script exited with code ${response.exitCode ?? "timeout"}`);
    },
    onError: async (error) => {
      setHistoryPage(1);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions", tunnel.id] }),
        queryClient.invalidateQueries({ queryKey: ["tunnels"] })
      ]);
      setExpandLatestAfterExecution(true);
      toast.error(error instanceof Error ? error.message : "Unable to execute script");
    }
  });
  const refreshHistory = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: ["command-executions", tunnel.id], type: "active" }),
    onError: () => toast.error("Unable to refresh execution history")
  });
  const saveInlineExecution = useMutation({
    mutationFn: (execution: TunnelCommandExecution) => api.post<{ executionId: string; scriptId: string; versionId: string; version: number; alreadySaved: boolean }>(`/api/tunnels/${tunnel.id}/commands/executions/${execution.id}/save-script`, { name: execution.scriptName ?? "Inline script" }),
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions", tunnel.id] }),
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["script-detail", saved.scriptId] })
      ]);
      toast.success(saved.alreadySaved ? "Script is already in the library" : "Inline script saved to the library");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save inline script")
  });
  const agent = tunnel.commandAgent!;
  const executions = executionData?.executions ?? [];
  const historyPagination = executionData?.pagination;
  const historySummary = executionData?.summary ?? emptyExecutionStats;
  const enrollmentById = new Map((tunnel.enrollments ?? []).map((enrollment) => [enrollment.id, enrollment]));
  useEffect(() => {
    if (expandLatestAfterExecution && executions[0]) {
      setExpandedExecutionId(executions[0].id);
      setExpandLatestAfterExecution(false);
    }
  }, [executions, expandLatestAfterExecution]);
  const canExecute = Boolean(hostPlatform) && !execute.isPending && (executionMode === "saved" ? Boolean(selectedVersionId) : Boolean(inlineName.trim() && inlineContent.trim()));
  return <>
    <section className="command-agent-panel">
      <header><div><h3>Command agent</h3><code>{agent.endpoint}</code></div><StatusBadge status={agent.status} /></header>
      {agent.lastError && <div className="inline-alert">{agent.lastError}</div>}
      {!hostPlatform ? <div className="inline-alert">An active enrollment is required before running a script.</div> : <>
        <div className="command-mode-toggle" role="tablist" aria-label="Script source">
          <button type="button" role="tab" aria-selected={executionMode === "saved"} className={executionMode === "saved" ? "active" : ""} onClick={() => setExecutionMode("saved")}>Saved script</button>
          <button type="button" role="tab" aria-selected={executionMode === "inline"} className={executionMode === "inline" ? "active" : ""} onClick={() => setExecutionMode("inline")}>Inline script</button>
        </div>
        {executionMode === "saved" ? <div className="command-saved-script">
          <div className="command-script-picker">
            <label className="field command-saved-script-field"><span className="field-label">Saved script <FieldHelp text="Search scripts compatible with the active enrollment. Management and quick-create actions are available inside the dropdown." /></span><SearchableSelect name="commandScript" value={selectedScriptId} options={pickerOptions} ariaLabel="Select saved script" placeholder="Select a saved script" emptyMessage="No compatible scripts" onValueChange={(value) => { setSelectedScriptId(value); setSelectedVersionId(""); }} actions={[
              { label: "Manage scripts", icon: <Settings2 size={14} />, onSelect: () => navigate("/scripts") },
              { label: "Create new", icon: <FilePlus2 size={14} />, onSelect: openQuickCreate }
            ]} /></label>
            <label className="field"><span className="field-label">Version <FieldHelp text="Select the exact immutable script version to execute. The execution history retains this version reference." /></span><select value={selectedVersionId} disabled={!selectedScript} onChange={(event) => setSelectedVersionId(event.target.value)}>{!selectedScript && <option value="">Select a script first</option>}{selectedScript && !selectedScript.versions.length && <option value="">No version available</option>}{selectedScript?.versions.map((version) => <option value={version.id} key={version.id}>Version {version.version}</option>)}</select></label>
          </div>
          {selectedScript && selectedScriptVersion && <div className="command-script-preview"><header><div><strong>Script preview</strong><span>{selectedScript.name} · Version {selectedScriptVersion.version}</span></div><code>{selectedScript.language}</code></header><ScriptEditor value={selectedScriptVersion.content} language={selectedScript.language} height="220px" readOnly /></div>}
        </div> : <div className="command-inline-script">
          <div className="command-inline-heading"><div><strong>Inline script</strong><span>Runs once and stays outside the library unless saved from history.</span></div></div>
          <div className="command-inline-metadata"><label className="field"><span className="field-label">Name <FieldHelp text="Identifies this one-off execution in tunnel history. It is also used if you later save the execution to the script library. Defaults from the script's first line until you edit it." /></span><input value={inlineName} maxLength={120} onChange={(event) => { setInlineName(event.target.value); setInlineNameTouched(true); }} placeholder="One-off maintenance" /></label>{hostPlatform === "unix" ? <label className="field"><span className="field-label">Language</span><select aria-label="Inline script language" value={inlineLanguage} onChange={(event) => setInlineLanguage(event.target.value as typeof inlineLanguage)}><option value="bash">Bash</option><option value="sh">POSIX sh</option></select></label> : <label className="field"><span className="field-label">Language</span><input value="PowerShell" disabled /></label>}</div>
          <ScriptEditor value={inlineContent} language={inlineLanguage} height="220px" onChange={setInlineContent} />
        </div>}
        <div className="command-execution-controls"><ArgumentSummary argumentsList={executionMode === "saved" ? resolvedVariableData?.arguments ?? [] : inlineArguments} data={resolvedVariableData} loading={variablesLoading} error={variablesError} /><button className="button button-primary command-execute-button" type="button" disabled={!canExecute} onClick={() => { setArgumentBindings({}); setExecuteConfirmOpen(true); }}><TerminalSquare size={15} />Execute script</button></div>
      </>}
      <div className="command-execution-history"><header><h4>Execution history</h4><div className="command-history-head-actions"><ExecutionStatsSummary stats={historySummary} /><span>{historyPagination?.total ?? 0} run{historyPagination?.total === 1 ? "" : "s"}</span><button className="icon-button" type="button" title="Refresh execution history" aria-label="Refresh execution history" disabled={refreshHistory.isPending} onClick={() => refreshHistory.mutate()}><RefreshCw size={14} className={refreshHistory.isPending ? "spin-icon" : undefined} /></button></div></header><div className="execution-history-filters"><label className="execution-history-search"><Search size={14} /><input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search script, description, tunnel, tenant, or code" aria-label="Search tunnel execution history" /></label><label><span>From</span><input type="datetime-local" step="60" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} aria-label="Filter tunnel execution history from time" /></label><label><span>To</span><input type="datetime-local" step="60" value={historyTo} onChange={(event) => setHistoryTo(event.target.value)} aria-label="Filter tunnel execution history to time" /></label></div>{executions.length ? executions.map((execution: TunnelCommandExecution) => {
        const enrollment = execution.enrollmentId ? enrollmentById.get(execution.enrollmentId) : undefined;
        const environment = enrollment ? enrollmentEnvironment(enrollment) : "Enrollment unavailable";
        const computerName = enrollment ? enrollmentComputerName(enrollment) : "Enrollment unavailable";
        const statusLabel = execution.status === "succeeded" ? "Succeeded" : execution.status === "failed" ? "Error" : execution.status === "timed_out" ? "Timeout" : execution.status === "cancelled" ? "Cancelled" : execution.status === "scheduled" ? "Scheduled" : execution.status === "never_run" ? "Never run" : "Running";
        const managedScriptId = execution.scriptId ?? execution.savedScriptId;
        const managedVersion = execution.scriptVersion ?? (execution.savedScriptVersionId ? 1 : null);
        const scriptLabel = `${execution.scriptName ?? "Saved script"}${managedVersion ? ` v${managedVersion}` : ""}`;
        const inlineName = execution.scriptName ?? "Inline script";
        const isInline = execution.scriptType === "inline" && !execution.savedScriptId;
        const isBulk = Boolean(execution.bulkExecutionId);
        const isSaving = saveInlineExecution.isPending && saveInlineExecution.variables?.id === execution.id;
        const executionLanguage = execution.language ?? (execution.platform === "windows" ? "powershell" : "bash");
        const executionTime = execution.startedAt ?? execution.createdAt;
        return <details className={`command-execution command-execution-${execution.status}`} key={execution.id} open={expandedExecutionId === execution.id} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(execution.id); else if (expandedExecutionId === execution.id) setExpandedExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={execution.status} label={statusLabel} />{isBulk && <span className="command-execution-source-tag">bulk</span>}<span className="command-execution-script-identity">{isInline ? <><span className="command-execution-source-tag">inline</span><strong className="command-execution-inline-name">{inlineName}</strong></> : managedScriptId ? <button className="command-execution-script-link" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openScriptDrawer(managedScriptId, managedVersion); }}>{scriptLabel}</button> : <strong>{scriptLabel}</strong>}</span><span className="host-identity" title={environment}><HostPlatformIcon environment={enrollment?.environment} platform={enrollment?.platform} osName={enrollment?.hostInfo.osName} /><code>{computerName}</code></span></span><span className="command-execution-timing"><time>{new Date(executionTime).toLocaleString()}</time><code>{execution.elapsedMs !== null ? `${execution.elapsedMs} ms` : execution.status}</code></span></summary>{expandedExecutionId === execution.id && <div className="command-execution-body">{(isInline || (isBulk && managedScriptId && execution.bulkExecutionId)) && <div className="command-execution-actions">{isInline && <button className="button button-secondary button-small" type="button" disabled={isSaving} onClick={() => saveInlineExecution.mutate(execution)}><Save size={14} />{isSaving ? "Saving..." : "Save script"}</button>}{isBulk && managedScriptId && execution.bulkExecutionId && <button className="button button-secondary button-small" type="button" onClick={() => openScriptDrawer(managedScriptId, managedVersion, { bulkRunId: execution.bulkExecutionId! })}><Layers3 size={14} />Open bulk run details</button>}</div>}<ScriptEditor value={execution.script} language={executionLanguage} height="200px" readOnly compactLineNumberGutter /><ExecutionLog tunnelId={tunnel.id} execution={execution} /></div>}</details>;
      }) : <div className="quiet-empty">No scripts have been executed for this tunnel.</div>}{historyPagination && historyPagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous execution page" aria-label="Previous execution page" disabled={historyPagination.page <= 1} onClick={() => { setExpandedExecutionId(null); setHistoryPage((page) => Math.max(1, page - 1)); }}><ChevronLeft size={15} /></button><span>Page {historyPagination.page} of {historyPagination.totalPages}</span><button className="icon-button" type="button" title="Next execution page" aria-label="Next execution page" disabled={historyPagination.page >= historyPagination.totalPages} onClick={() => { setExpandedExecutionId(null); setHistoryPage((page) => page + 1); }}><ChevronRight size={15} /></button></div>}</div>
    </section>
    <Modal open={quickCreateOpen} title="Create new script" onClose={() => setQuickCreateOpen(false)} width="wide">
      <div className="command-quick-create"><div className="script-metadata-grid command-quick-create-fields"><label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown in the script picker. Names must be unique within the platform." /></span><input value={quickName} onChange={(event) => setQuickName(event.target.value)} placeholder="Tunnel health check" /></label><label className="field"><span className="field-label">Language</span><select value={quickLanguage} onChange={(event) => setQuickLanguage(event.target.value as typeof quickLanguage)}>{hostPlatform === "windows" ? <option value="powershell">PowerShell</option> : <><option value="bash">Bash</option><option value="sh">POSIX sh</option></>}</select></label><label className="field"><span className="field-label">Description</span><input value={quickDescription} onChange={(event) => setQuickDescription(event.target.value)} placeholder="Optional description" /></label><label className="field"><span className="field-label">Default timeout (seconds)</span><input type="number" min={1} max={300} value={quickTimeoutSeconds} onChange={(event) => setQuickTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label></div><ScriptArgumentsEditor argumentsList={quickArguments} onChange={setQuickArguments} /><ScriptEditor value={quickContent} language={quickLanguage} height="300px" onChange={setQuickContent} /><div className="form-actions"><span className="script-editor-hint">Creates version 1 and selects it for this run</span><button className="button button-primary" type="button" disabled={!quickName.trim() || !quickContent.trim() || quickCreate.isPending} onClick={() => quickCreate.mutate()}><Save size={15} />{quickCreate.isPending ? "Saving..." : "Save script"}</button></div></div>
    </Modal>
    <Modal open={executeConfirmOpen} title={`Execute · ${executionMode === "saved" ? selectedScript?.name ?? "saved script" : inlineName || "inline script"}`} onClose={() => setExecuteConfirmOpen(false)} width="wide">
      <div className="execution-confirmation">{variablesErrored ? <div className="inline-alert">{variablesError instanceof Error ? variablesError.message : "Unable to resolve available variables"}<button className="button button-secondary button-small" type="button" onClick={() => refetchVariables()}><RefreshCw size={14} />Retry</button></div> : variablesLoading || !resolvedVariableData ? <div className="quiet-empty">Resolving available variables...</div> : <>
        <div className="execution-confirmation-summary"><div><strong>{tunnel.displayName}</strong><span>{executionMode === "saved" ? `Version ${selectedScriptVersion?.version ?? "-"}` : "Inline script"}</span></div></div>
        {executionMode === "inline"
          ? <InlineArgumentsEditor argumentsList={inlineArguments} onChange={setInlineArguments} availableVariables={resolvedVariableData.availableVariables} sources={resolvedVariableData.sources} />
          : <ArgumentBindingsEditor argumentsList={resolvedVariableData.arguments} bindings={argumentBindings} availableVariables={resolvedVariableData.availableVariables} sources={resolvedVariableData.sources} onChange={setArgumentBindings} />}
        <div className="form-actions"><button className="button button-secondary cancel-button-left" type="button" onClick={() => setExecuteConfirmOpen(false)}>Cancel</button><span>{executionMode === "saved" ? `${Object.keys(argumentBindings).length} argument${Object.keys(argumentBindings).length === 1 ? "" : "s"} mapped` : `${inlineArguments.length} argument${inlineArguments.length === 1 ? "" : "s"} declared`}</span><label className="field bulk-timeout-field"><span className="field-label">Timeout (s) <FieldHelp text="The maximum time the command agent may let this script run before terminating it. Allowed range: 1 to 300 seconds." /></span><input type="number" min={1} max={300} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label><button className="button button-primary" type="button" disabled={execute.isPending || Boolean(missingRequiredArgumentNames(executionMode === "saved" ? resolvedVariableData.arguments : inlineArguments, argumentBindings, resolvedVariableData.availableVariables).length)} onClick={() => execute.mutate(argumentBindings)}><TerminalSquare size={15} />{execute.isPending ? "Executing..." : "Confirm execution"}</button></div>
      </>}</div>
    </Modal>
  </>;
}

function EditConnectivityPanel({ tunnel, onClose }: { tunnel: Tunnel; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [publications, setPublications] = useState<DraftPublication[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    setPublications(tunnel?.publications.map((publication) => ({
      key: publication.id,
      suffix: publication.suffix,
      useCustomLabel: Boolean(publication.customLabel),
      customLabel: publication.customLabel ?? "",
      routes: publication.routes.map((route) => ({ key: route.id, path: route.path, serviceUrl: route.serviceUrl, kind: route.kind ?? "service" }))
    })) ?? []);
  }, [tunnel.id]);
  const mutation = useMutation({
    mutationFn: () => api.put<{ success: boolean; applied: boolean }>(`/api/tunnels/${tunnel!.id}/connectivity`, { publications: connectivityPayload(publications) }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] })
      ]);
      toast.success(result.applied ? "Tunnel connectivity updated" : "Connectivity saved for provisioning");
      onClose();
    },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to update connectivity")
  });
  const save = () => {
    const validationError = validatePublications(publications);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    mutation.mutate();
  };
  return <section className="tunnel-drawer-section connectivity-inline-editor">
    <header className="tunnel-section-heading"><div><h3>Edit connectivity</h3><span>{tunnel.displayName} · update published subdomains and ingress paths</span></div><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button></header>
    <div className="connectivity-scope"><div><span>Cloudflare account</span><strong>{tunnel.accountName}</strong></div><div><span>DNS zone</span><strong>{tunnel.zoneName}</strong></div><div><span>Tunnel</span><strong className="mono">{tunnel.cfTunnelId ?? "Pending installation"}</strong></div></div>
    <ConnectivityEditor tunnelId={tunnel.tunnelCode} zoneName={tunnel.zoneName} publications={publications} onChange={setPublications} />
    <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={save} disabled={mutation.isPending}>{mutation.isPending ? "Updating..." : "Save connectivity"}</button></div>
    {error && <div className="form-error">{error}</div>}
  </section>;
}

// The guided, one-field version of adding an ssh:// route: unlike RDP,
// SSH's ingress route is just an ordinary publication (see ssh.ts), so this
// reuses the same connectivity-update endpoint EditConnectivityPanel does -
// it only needs a subdomain, since the route itself always targets
// ssh://127.0.0.1:22 (cloudflared and sshd run on the same host). Anyone
// who wants a different port/IP can still use Edit Connectivity directly.
function EnableSshDialog({ tunnel, open, onClose }: { tunnel: Tunnel; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [subdomain, setSubdomain] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) { setSubdomain(""); setError(""); }
  }, [open]);
  const mutation = useMutation({
    mutationFn: (publications: DraftPublication[]) => api.put<{ success: boolean; applied: boolean }>(`/api/tunnels/${tunnel.id}/connectivity`, { publications: connectivityPayload(publications) }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] })
      ]);
      toast.success("SSH route added - browser SSH is provisioning");
      onClose();
    },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to add the SSH route")
  });
  const submit = () => {
    const trimmed = subdomain.trim().toLowerCase();
    if (!trimmed) { setError("Enter a subdomain"); return; }
    const draftPublications: DraftPublication[] = [
      ...tunnel.publications.map((publication) => ({
        key: publication.id,
        suffix: publication.suffix,
        useCustomLabel: Boolean(publication.customLabel),
        customLabel: publication.customLabel ?? "",
        routes: publication.routes.map((route) => ({ key: route.id, path: route.path, serviceUrl: route.serviceUrl, kind: route.kind ?? "service" }))
      })),
      {
        key: "new-ssh",
        suffix: "",
        useCustomLabel: true,
        customLabel: trimmed,
        routes: [{ key: "new-ssh-route", path: "/", serviceUrl: "ssh://127.0.0.1:22", kind: "service" }]
      }
    ];
    const validationError = validatePublications(draftPublications);
    if (validationError) { setError(validationError); return; }
    setError("");
    mutation.mutate(draftPublications);
  };
  return <Modal open={open} title="Enable SSH" onClose={onClose}>
    <div className="form-stack">
      <label className="field"><span className="field-label">Subdomain <FieldHelp text="The full subdomain to publish, e.g. ssh-my-machine - resolves to <subdomain>.<zone>. Routes to ssh://127.0.0.1:22 on this machine; use Edit Connectivity afterward for a different port or target." /></span><input value={subdomain} onChange={(event) => setSubdomain(event.target.value)} placeholder="ssh-my-machine" maxLength={63} autoFocus /></label>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={submit} disabled={mutation.isPending}>{mutation.isPending ? "Enabling..." : "Enable SSH"}</button></div>
    </div>
  </Modal>;
}

function RouteWafDialog({ tunnel, route, onClose }: { tunnel: Tunnel | null; route: TunnelRoute | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(true);
  const [allowedIps, setAllowedIps] = useState("");
  const [error, setError] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["route-waf", tunnel?.id, route?.id],
    queryFn: () => api.get<{ waf: { enabled: boolean; allowedIps: string[]; defaulted: boolean; cloudflareManIps: string[]; currentIp: string | null; mandatory: boolean; remoteAgentPath: boolean; remoteAgentWarning: string | null; ruleId: string | null } }>(`/api/tunnels/${tunnel!.id}/routes/${route!.id}/waf`),
    enabled: Boolean(tunnel && route)
  });
  const mandatory = data?.waf.mandatory ?? false;
  const remoteAgentPath = data?.waf.remoteAgentPath ?? false;
  // Cloudflare folds every WAF-protected route in the zone into a shared
  // pool of custom rules (see CloudflareClient.configureZoneWaf) rather than
  // one rule per route, so this deep link goes straight to whichever pool
  // rule currently contains this route instead of a generic rules list.
  const wafRuleUrl = data?.waf.ruleId && tunnel?.cfAccountId
    ? `https://dash.cloudflare.com/${encodeURIComponent(tunnel.cfAccountId)}/${encodeURIComponent(tunnel.zoneName)}/security/security-rules/custom-rules/${encodeURIComponent(data.waf.ruleId)}`
    : null;
  useEffect(() => {
    if (!route) return;
    setEnabled(route.wafEnabled);
    setAllowedIps(route.wafAllowedIps.join("\n"));
    setError("");
  }, [route]);
  useEffect(() => {
    if (!data?.waf) return;
    setEnabled(data.waf.enabled);
    setAllowedIps(data.waf.allowedIps.join("\n"));
  }, [data]);
  const mutation = useMutation({
    mutationFn: () => api.patch<{ waf: { enabled: boolean; allowedIps: string[] }; warning: string | null }>(`/api/tunnels/${tunnel!.id}/routes/${route!.id}/waf`, {
      enabled: mandatory ? true : enabled,
      allowedIps: allowedIps.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean)
    }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel?.id] }),
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["route-waf", tunnel?.id, route?.id] })
      ]);
      if (result.warning) toast.warning(result.warning);
      else toast.success("Route WAF updated");
      onClose();
    },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to update route WAF")
  });
  const cloudflareManIps = data?.waf.cloudflareManIps ?? [];
  const currentIps = allowedIps.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
  const missingCloudflareManIps = cloudflareManIps.filter((ip) => !currentIps.includes(ip));
  const addCloudflareManOrigin = () => {
    if (!missingCloudflareManIps.length) return;
    setAllowedIps([...currentIps, ...missingCloudflareManIps].join("\n"));
  };
  const myIp = data?.waf.currentIp ?? null;
  const addMyIp = () => {
    if (!myIp || currentIps.includes(myIp)) return;
    setAllowedIps([...currentIps, myIp].join("\n"));
  };
  return <Modal open={Boolean(tunnel && route)} title={`Route WAF · ${route?.path ?? ""}`} onClose={onClose}>
    {route && <div className="route-waf-dialog">
      {error && <div className="form-error">{error}</div>}
      {isLoading ? <div className="quiet-empty">Loading WAF policy...</div> : <>
        {mandatory
          ? <div className="inline-alert"><ShieldAlert size={15} />This is the command agent route - its remote command execution endpoint - so allow-list protection always stays on and can't be disabled here.</div>
          : <label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>Allow-list protection</strong><small>When enabled, Cloudflare blocks every source IP except the addresses below.</small></span></label>}
        {(mandatory || enabled) && wafRuleUrl && <a className="mono detail-link route-waf-rule-link" href={wafRuleUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open the Cloudflare custom rule protecting this route</a>}
        {remoteAgentPath && (mandatory || enabled) && <div className="inline-alert"><ShieldAlert size={15} />{data?.waf.remoteAgentWarning}</div>}
        <label className="field"><span className="field-label">Allowed CFMan IPs or CIDRs <FieldHelp text="Use one public IPv4, IPv6, or CIDR per line. Leave the list unchanged to use the server's configured CFMan source IP. Never use 0.0.0.0/0 unless this route is intentionally public." /></span><textarea value={allowedIps} onChange={(event) => setAllowedIps(event.target.value)} rows={4} placeholder="203.0.113.10/32" disabled={!mandatory && !enabled} /></label>
        <div className="route-waf-quick-add">
          <button className="button button-secondary" type="button" onClick={addCloudflareManOrigin} disabled={!missingCloudflareManIps.length}><ShieldCheck size={15} />Add CFMan origin{cloudflareManIps.length ? ` (${cloudflareManIps.join(", ")})` : ""}</button>
          <button className="button button-secondary" type="button" onClick={addMyIp} disabled={!myIp || currentIps.includes(myIp)}><Globe2 size={15} />Add my current IP{myIp ? ` (${myIp})` : ""}</button>
        </div>
        {data?.waf.defaulted && <div className="inline-note"><ShieldCheck size={15} />The addresses were resolved from CFMAN_WAF_ALLOWED_IPS or the CFMan server's public IP.</div>}
      </>}
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={() => mutation.mutate()} disabled={isLoading || mutation.isPending}>{mutation.isPending ? "Updating..." : "Save WAF policy"}</button></div>
    </div>}
  </Modal>;
}

function formatExpiry(expiresAt: string): string {
  const absolute = new Date(expiresAt).toLocaleString();
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return `Expired ${absolute}`;
  const totalMinutes = Math.max(1, Math.round(diffMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `Expires in ${duration} (${absolute})`;
}

function ExpiryLine({ expiresAt }: { expiresAt: string }) {
  return <div className="expiry-line">{formatExpiry(expiresAt)}</div>;
}

// Tunnel administrators paste this into an elevated Command Prompt as often as an
// elevated PowerShell, so the one-liner invokes powershell.exe explicitly instead of
// relying on the host shell. TLS 1.2 must be forced here, before the download, for
// tunnels on older Windows builds that still default to TLS 1.0.
function windowsBootstrapCommand(url: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm '${url}' | iex"`;
}

export function EnrollmentCommands({ result, defaultPlatform = "windows" }: { result: EnrollmentResult; defaultPlatform?: "windows" | "unix" }) {
  const [platform, setPlatform] = useState<"windows" | "unix">(defaultPlatform);
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: AppSettings }>("/api/settings") });
  const withCurrentBaseUrl = (value: string) => {
    if (!data?.settings.publicBaseUrl) return value;
    const url = new URL(value);
    return `${data.settings.publicBaseUrl}${url.pathname}${url.search}`;
  };
  const powershellUrl = withCurrentBaseUrl(result.urls.powershell);
  const shellUrl = withCurrentBaseUrl(result.urls.shell);
  const command = platform === "windows" ? windowsBootstrapCommand(powershellUrl) : `curl -fsSL '${shellUrl}' | sudo bash`;
  return <div className="enrollment-command-stack">
    <div className="command-section"><div className="command-head"><div className="segmented compact"><button type="button" className={platform === "windows" ? "active" : ""} onClick={() => setPlatform("windows")}>PowerShell</button><button type="button" className={platform === "unix" ? "active" : ""} onClick={() => setPlatform("unix")}>Bash</button></div><CopyButton value={command} label="Copy command" /></div><pre><code>{command}</code></pre>{platform === "windows" && <div className="command-note"><ShieldAlert size={14} />Run as Administrator, from Command Prompt or PowerShell. <FieldHelp text="This command forces TLS 1.2 before downloading, which covers Windows 7 SP1 / Server 2008 R2 and later (including 8, 8.1, 10, 11, and Server 2012-2022). It cannot help Windows Vista, Server 2008 RTM, XP, or Server 2003, since those never implemented TLS 1.2 at the OS level." /></div>}<ExpiryLine expiresAt={result.expiresAt} /></div>
  </div>;
}

function UnenrollHelperPanel({ tunnelId, enrollment, status }: { tunnelId: string; enrollment: TunnelEnrollment; status: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["enrollment-unenroll-script", tunnelId, enrollment.id],
    queryFn: () => api.get<{ powershell: string | null; shell: string | null }>(`/api/tunnels/${tunnelId}/enrollments/${enrollment.id}/unenroll-script`),
    enabled: Boolean(tunnelId && enrollment.id),
    refetchInterval: status === "unenroll_pending" ? 2000 : false
  });
  if (isLoading) return null;
  if (!data?.powershell && !data?.shell) return null;
  const note = status === "unenroll_failed"
    ? `${enrollment.unenrollLastError ?? "Automatic unenrollment failed"}. Run this cleanup command on the connected tunnel machine.`
    : "Unenrollment was scheduled through the command agent. Run this manual command only if it does not complete on its own.";
  return <div className="unenroll-command-panel">
    <div className="command-note"><ShieldAlert size={14} />{note}</div>
    <EnrollmentCommands result={{ id: enrollment.id, expiresAt: enrollment.unenrollTokenExpiresAt!, urls: { powershell: data.powershell ?? "", shell: data.shell ?? "" } }} defaultPlatform={enrollment.platform === "unix" ? "unix" : "windows"} />
  </div>;
}

function DiagnosticCommands({ result }: { result: DiagnoseResult }) {
  const [platform, setPlatform] = useState<"windows" | "unix">(result.platform);
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: AppSettings }>("/api/settings") });
  const withCurrentBaseUrl = (value: string) => {
    if (!data?.settings.publicBaseUrl) return value;
    const url = new URL(value);
    return `${data.settings.publicBaseUrl}${url.pathname}${url.search}`;
  };
  const powershellUrl = withCurrentBaseUrl(result.urls.powershell);
  const shellUrl = withCurrentBaseUrl(result.urls.shell);
  const command = platform === "windows" ? windowsBootstrapCommand(powershellUrl) : `curl -fsSL '${shellUrl}' | bash`;
  return <div className="command-section">
    <div className="command-head">
      <div className="segmented compact"><button type="button" className={platform === "windows" ? "active" : ""} onClick={() => setPlatform("windows")}>PowerShell</button><button type="button" className={platform === "unix" ? "active" : ""} onClick={() => setPlatform("unix")}>Bash</button></div>
      <CopyButton value={command} label="Copy diagnostic command" />
    </div>
    <pre><code>{command}</code></pre>
    <div className="command-note"><ShieldAlert size={14} />Run this on the tunnel machine. It checks cloudflared, local enrollment state, and the command agent, then reports the result back here automatically.</div>
    <ExpiryLine expiresAt={result.expiresAt} />
  </div>;
}

type TroubleshootStepStatus = "pending" | "checking" | "pass" | "fail";
type TroubleshootStep = { key: string; label: string; status: TroubleshootStepStatus; detail?: string | undefined };

function TroubleshootDialog({ tunnel, open, onClose, onManageWaf }: { tunnel: Tunnel; open: boolean; onClose: () => void; onManageWaf: (route: TunnelRoute) => void }) {
  const queryClient = useQueryClient();
  const routes = (tunnel.publications ?? []).flatMap((publication) => publication.routes.filter((route) => route.kind === "service").map((route) => route));
  const buildSteps = (): TroubleshootStep[] => [
    { key: "tunnel", label: "Cloudflare tunnel", status: "pending" },
    ...(tunnel.commandAgent ? [{ key: "agent", label: "Command agent", status: "pending" as TroubleshootStepStatus }] : []),
    ...routes.map((route) => ({ key: route.id, label: route.path, status: "pending" as TroubleshootStepStatus }))
  ];
  const [steps, setSteps] = useState<TroubleshootStep[]>(buildSteps);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [diagnose, setDiagnose] = useState<DiagnoseResult | null>(null);
  const issueDiagnose = useMutation({
    mutationFn: () => api.post<DiagnoseResult>(`/api/tunnels/${tunnel.id}/diagnose`),
    onSuccess: async (result) => {
      setDiagnose(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["enrollment-logs", tunnel.id, result.enrollmentId] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-enrollments", tunnel.id] })
      ]);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to generate a diagnostic command")
  });

  const updateStep = (key: string, patch: Partial<TroubleshootStep>) => {
    setSteps((current) => current.map((step) => step.key === key ? { ...step, ...patch } : step));
  };

  const runChecks = async () => {
    setSteps(buildSteps());
    setExpanded({});
    setDiagnose(null);

    updateStep("tunnel", { status: "checking" });
    await api.post("/api/tunnels/refresh", { tunnelIds: [tunnel.id] }).catch(() => null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
      queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] })
    ]);
    const fresh = queryClient.getQueryData<{ tunnel: Tunnel }>(["tunnel-detail", tunnel.id])?.tunnel ?? tunnel;
    const tunnelOk = tunnelOnlineStatus(fresh.cfTunnelStatus) === "online";
    updateStep("tunnel", { status: tunnelOk ? "pass" : "fail" });

    if (fresh.commandAgent) {
      updateStep("agent", { status: fresh.commandAgent.status === "ready" ? "pass" : "fail", detail: fresh.commandAgent.lastError ?? undefined });
    }

    for (const route of routes) {
      updateStep(route.id, { status: "checking" });
      const result = await api.post<{ success: boolean; check: { error?: string } }>(`/api/tunnels/${tunnel.id}/verify`, { routeId: route.id }).catch(() => null);
      updateStep(route.id, { status: result?.success ? "pass" : "fail", detail: result?.check.error });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
        queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] })
      ]);
    }
  };

  useEffect(() => {
    if (open) void runChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tunnel.id]);

  const toggleExpand = (key: string) => setExpanded((current) => ({ ...current, [key]: !current[key] }));
  const verifyRoute = (routeId: string) => {
    updateStep(routeId, { status: "checking" });
    api.post<{ success: boolean; check: { error?: string } }>(`/api/tunnels/${tunnel.id}/verify`, { routeId })
      .then(async (result) => {
        updateStep(routeId, { status: result.success ? "pass" : "fail", detail: result.check.error });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["tunnels"] }),
          queryClient.invalidateQueries({ queryKey: ["tunnel-detail", tunnel.id] })
        ]);
      })
      .catch(() => updateStep(routeId, { status: "fail" }));
  };

  return <Modal open={open} title={`Troubleshoot · ${tunnel.displayName}`} onClose={onClose} width="wide">
    <div className="troubleshoot-steps">
      {steps.map((step) => {
        const isConnectionStep = step.key === "tunnel" || step.key === "agent";
        return <div className={`troubleshoot-step troubleshoot-step-${step.status}`} key={step.key}>
          <div className="troubleshoot-step-head">
            <span className="troubleshoot-step-icon">
              {step.status === "checking" && <RefreshCw size={15} className="spin-icon" />}
              {step.status === "pass" && <CheckCircle2 size={15} />}
              {step.status === "fail" && <AlertTriangle size={15} />}
              {step.status === "pending" && <span className="troubleshoot-step-dot" />}
            </span>
            <span className="troubleshoot-step-label">{step.label}</span>
            {step.status === "fail" && <button className="button button-secondary button-small" type="button" onClick={() => toggleExpand(step.key)}>{expanded[step.key] ? "Hide" : "Resolve"}</button>}
          </div>
          {step.status === "fail" && expanded[step.key] && <div className="troubleshoot-step-guidance">
            {isConnectionStep ? <>
              <p>{step.key === "tunnel" ? "The Cloudflare tunnel is not connected." : "The command agent is not responding."} Run this on the tunnel machine - it checks cloudflared, local enrollment state, and the command agent, then reports back automatically.</p>
              {diagnose ? <DiagnosticCommands result={diagnose} /> : <button className="button button-primary" type="button" onClick={() => issueDiagnose.mutate()} disabled={issueDiagnose.isPending}><TerminalSquare size={15} />{issueDiagnose.isPending ? "Generating..." : "Generate diagnostic command"}</button>}
            </> : <>
              <p>{step.detail || "This endpoint did not respond successfully."}</p>
              <div className="form-actions">
                <button className="button button-secondary" type="button" onClick={() => verifyRoute(step.key)}><RefreshCw size={14} />Verify again</button>
                <button className="button button-secondary" type="button" onClick={() => { const route = routes.find((item) => item.id === step.key); if (route) onManageWaf(route); }}><ShieldCheck size={14} />Manage WAF</button>
              </div>
            </>}
          </div>}
        </div>;
      })}
    </div>
  </Modal>;
}
