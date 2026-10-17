import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Plus, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { useDrawers } from "../components/DrawerContext";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import type { AutomationRule, NotificationChannel } from "../types";

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function AutomationPage() {
  const queryClient = useQueryClient();
  const { openAutomationRuleDrawer, openChannelDrawer } = useDrawers();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "channels" ? "channels" : "rules";
  const [search, setSearch] = useState("");

  const { data: ruleData, isLoading: rulesLoading } = useQuery({
    queryKey: ["automation", "rules", search],
    queryFn: () => api.get<{ rules: AutomationRule[] }>(`/api/automation/rules${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ""}`),
    refetchInterval: 30_000
  });
  const { data: channelData, isLoading: channelsLoading } = useQuery({
    queryKey: ["notifications", "channels"],
    queryFn: () => api.get<{ channels: NotificationChannel[] }>("/api/notifications/channels")
  });

  const refresh = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: [tab === "rules" ? "automation" : "notifications"], type: "active" }),
    onSuccess: () => toast.success(tab === "rules" ? "Rules refreshed" : "Channels refreshed"),
    onError: () => toast.error("Unable to refresh")
  });

  const rules = ruleData?.rules ?? [];
  const channels = channelData?.channels ?? [];
  const filteredChannels = search.trim()
    ? channels.filter((channel) => `${channel.key} ${channel.name} ${channel.description}`.toLowerCase().includes(search.trim().toLowerCase()))
    : channels;

  const toggleRule = useMutation({
    mutationFn: (rule: AutomationRule) => api.patch<{ success: boolean }>(`/api/automation/rules/${rule.id}`, { enabled: !rule.enabled }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["automation"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to update the rule")
  });

  return <div className="page">
    <PageHeader
      title="Automation"
      eyebrow="Scheduled scripts"
      actions={<>
        <button className="button button-secondary" type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={15} className={refresh.isPending ? "spin-icon" : undefined} />{refresh.isPending ? "Refreshing..." : "Refresh"}</button>
        {tab === "rules"
          ? <button className="button button-primary" type="button" onClick={() => openAutomationRuleDrawer(null)}><Plus size={16} />New rule</button>
          : <button className="button button-primary" type="button" onClick={() => openChannelDrawer(null)}><MessageSquarePlus size={16} />New channel</button>}
      </>}
    />
    <div className="page-tabs">
      <button type="button" className={tab === "rules" ? "active" : undefined} onClick={() => setSearchParams({}, { replace: true })}>Rules</button>
      <button type="button" className={tab === "channels" ? "active" : undefined} onClick={() => setSearchParams({ tab: "channels" }, { replace: true })}>Notification channels</button>
    </div>
    <div className="toolbar">
      <label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === "rules" ? "Search rules" : "Search notification channels"} /></label>
    </div>

    {tab === "rules"
      ? <section className="panel table-panel automation-table-panel">
        <div className="table-scroll"><table><thead><tr><th>Rule</th><th>Schedule</th><th>Next run</th><th>Last run</th><th>Enabled</th></tr></thead><tbody>
          {rulesLoading
            ? <tr><td colSpan={5}><div className="quiet-empty">Loading rules...</div></td></tr>
            : rules.length === 0
              ? <tr><td colSpan={5}><div className="quiet-empty">No automation rule yet.</div></td></tr>
              : rules.map((rule) => <tr key={rule.id} className="data-row" tabIndex={0} onClick={() => openAutomationRuleDrawer(rule.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openAutomationRuleDrawer(rule.id); } }}>
                <td><div className="primary-cell"><strong>{rule.name}</strong><span>{rule.key}{rule.description ? ` · ${rule.description}` : ""}</span></div></td>
                <td><code className="automation-cron-cell">{rule.schedule.cron}</code><span className="automation-timezone-cell">{rule.schedule.timezone}</span></td>
                <td>{rule.enabled ? formatTimestamp(rule.nextRunAt) : "paused"}</td>
                <td>{rule.lastRunStatus ? <div className="automation-last-run"><StatusBadge status={rule.lastRunStatus} /><span>{formatTimestamp(rule.lastRunAt)}</span></div> : "—"}</td>
                <td onClick={(event) => event.stopPropagation()}>
                  <label className="switch-control"><input type="checkbox" checked={rule.enabled} disabled={toggleRule.isPending} onChange={() => toggleRule.mutate(rule)} /><span /></label>
                </td>
              </tr>)}
        </tbody></table></div>
      </section>
      : <section className="panel table-panel automation-table-panel">
        <div className="table-scroll"><table><thead><tr><th>Channel</th><th>Type</th><th>Target</th><th>Last used</th><th>Status</th></tr></thead><tbody>
          {channelsLoading
            ? <tr><td colSpan={5}><div className="quiet-empty">Loading channels...</div></td></tr>
            : filteredChannels.length === 0
              ? <tr><td colSpan={5}><div className="quiet-empty">No notification channel configured yet.</div></td></tr>
              : filteredChannels.map((channel) => <tr key={channel.id} className="data-row" tabIndex={0} onClick={() => openChannelDrawer(channel.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openChannelDrawer(channel.id); } }}>
                <td><div className="primary-cell"><strong>{channel.name}</strong><span>{channel.key}{channel.description ? ` · ${channel.description}` : ""}</span></div></td>
                <td><div className="automation-channel-type">{channel.typeLabel}{channel.supportsButtons && <span className="automation-buttons-chip" title={`A rule script can ask a question here with up to ${channel.maxButtons} buttons`}>buttons</span>}</div></td>
                <td>{channel.target}</td>
                <td>{formatTimestamp(channel.lastUsedAt)}</td>
                <td>{channel.lastError
                  ? <StatusBadge status="failed" label="last send failed" />
                  : <StatusBadge status={channel.enabled ? "enabled" : "inactive"} label={channel.enabled ? "enabled" : "disabled"} />}</td>
              </tr>)}
        </tbody></table></div>
      </section>}
  </div>;
}
