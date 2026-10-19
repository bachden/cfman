import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronLeft, ChevronRight, Code2, Play, Save, Trash2, Wand2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import {
  buildCron,
  DEFAULT_CRON_BUILDER,
  parseCron,
  parseTimeValue,
  timeValue,
  WEEKDAYS,
  type CronBuilderState,
  type CronFrequency
} from "../cron";
import type { AutomationCapabilities, AutomationRule, AutomationRun, NotificationChannel } from "../types";
import { useDrawers } from "./DrawerContext";
import { FieldHelp } from "./FieldHelp";
import { Modal } from "./Modal";
import { ScriptEditor } from "./ScriptEditor";
import { SideDrawer } from "./SideDrawer";
import { StatusBadge } from "./StatusBadge";

// One script is the whole rule: what to look at, what to do about it, and what
// to leave behind in the run history.
const DEFAULT_SCRIPT = `const { tunnels } = await cfman.listTunnels({ limit: 200 });
const offline = tunnels.filter((tunnel) => tunnel.cfTunnelStatus !== "healthy");
console.log(\`checked \${tunnels.length} tunnels, \${offline.length} unhealthy\`);

if (offline.length === 0) return "every tunnel is healthy";

// "ops-alerts" is a notification channel key; the keys you have are listed under this editor.
await cfman.sendMessage("ops-alerts", \`\${rule.name}: \${offline.map((tunnel) => tunnel.displayName).join(", ")} unhealthy\`);
return cfman.json({ total: tunnels.length, offline: offline.map((tunnel) => tunnel.displayName) });
`;

type RunActivityEntry =
  | { kind: "execution"; key: string; at: string; execution: AutomationRun["executions"][number] }
  | { kind: "prompt"; key: string; at: string; prompt: AutomationRun["prompts"][number] };

// One trace of what the run did, oldest first: an execution and a question are
// steps of the same script, so reading them apart hides the order they
// happened in.
function runActivity(run: AutomationRun): RunActivityEntry[] {
  return [
    ...run.executions.map((execution) => ({ kind: "execution" as const, key: `execution-${execution.id}`, at: execution.createdAt, execution })),
    ...run.prompts.map((prompt) => ({ kind: "prompt" as const, key: `prompt-${prompt.id}`, at: prompt.createdAt, prompt }))
  ].sort((left, right) => new Date(left.at).getTime() - new Date(right.at).getTime());
}

function formatTimestamp(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function emptyRuleForm(timezone: string) {
  return {
    key: "",
    name: "",
    description: "",
    enabled: true,
    cron: "*/15 * * * *",
    timezone,
    scriptSource: DEFAULT_SCRIPT,
    scriptTimeoutSeconds: 30
  };
}

type RuleForm = ReturnType<typeof emptyRuleForm>;

export function AutomationRuleDrawer({
  ruleId,
  initialRunId,
  onClose,
  width,
  onResize
}: {
  ruleId: string | null;
  initialRunId?: string | null | undefined;
  onClose: () => void;
  width: number;
  onResize: (width: number) => void;
}) {
  const queryClient = useQueryClient();
  const { openTunnelDrawer } = useDrawers();
  const isNew = ruleId === null;
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [form, setForm] = useState<RuleForm>(() => emptyRuleForm(browserTimezone));
  const [loadedRuleId, setLoadedRuleId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runPage, setRunPage] = useState(1);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(initialRunId ?? null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // An execution links back to the run that dispatched it; narrowing the
  // history to that run is what makes the link land regardless of paging.
  const [focusedRunId, setFocusedRunId] = useState<string | null>(initialRunId ?? null);
  const [scheduleMode, setScheduleMode] = useState<"builder" | "expression">("builder");
  const [builder, setBuilder] = useState<CronBuilderState>(() => parseCron(emptyRuleForm("UTC").cron) ?? DEFAULT_CRON_BUILDER);

  const { data: capabilities } = useQuery({
    queryKey: ["automation", "capabilities"],
    queryFn: () => api.get<AutomationCapabilities>("/api/automation/capabilities")
  });
  const { data: channelData } = useQuery({
    queryKey: ["notifications", "channels"],
    queryFn: () => api.get<{ channels: NotificationChannel[] }>("/api/notifications/channels")
  });
  const { data: ruleData } = useQuery({
    queryKey: ["automation", "rule", ruleId],
    queryFn: () => api.get<{ rule: AutomationRule }>(`/api/automation/rules/${ruleId}`),
    enabled: Boolean(ruleId)
  });

  useEffect(() => {
    const rule = ruleData?.rule;
    if (!rule || loadedRuleId === rule.id) return;
    setLoadedRuleId(rule.id);
    setSelectedVersion(rule.latestVersion);
    const parsed = parseCron(rule.schedule.cron);
    setBuilder(parsed ?? DEFAULT_CRON_BUILDER);
    // An expression the builder cannot express opens in the field that can.
    setScheduleMode(parsed ? "builder" : "expression");
    setForm({
      key: rule.key,
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      cron: rule.schedule.cron,
      timezone: rule.schedule.timezone,
      scriptSource: rule.versions?.[0]?.scriptSource ?? "",
      scriptTimeoutSeconds: Math.round(rule.scriptTimeoutMs / 1000)
    });
  }, [ruleData, loadedRuleId]);

  const { data: cronPreview, isError: cronInvalid, error: cronError } = useQuery({
    queryKey: ["automation", "cron-preview", form.cron, form.timezone],
    queryFn: () => api.post<{ nextRuns: string[]; description: string | null }>("/api/automation/cron/preview", { cron: form.cron, timezone: form.timezone }),
    enabled: form.cron.trim().length > 0,
    retry: false
  });

  const { data: runData } = useQuery({
    queryKey: ["automation", "runs", ruleId, runPage, focusedRunId],
    queryFn: () => api.get<{ runs: AutomationRun[]; pagination: { page: number; totalPages: number; total: number } }>(`/api/automation/rules/${ruleId}/runs?page=${runPage}&pageSize=10${focusedRunId ? `&runId=${focusedRunId}` : ""}`),
    enabled: Boolean(ruleId),
    refetchInterval: 15_000
  });

  const rule = ruleData?.rule;
  const versions = useMemo(() => rule?.versions ?? [], [rule]);
  const latestVersion = rule?.latestVersion ?? null;
  const latestSource = versions[0]?.scriptSource ?? "";
  const viewingLatest = selectedVersion === null || selectedVersion === latestVersion;
  // An older version is immutable, so it is shown as it was; the editable
  // buffer always belongs to the newest one.
  const editorValue = viewingLatest
    ? form.scriptSource
    : versions.find((entry) => entry.version === selectedVersion)?.scriptSource ?? form.scriptSource;

  // A builder change is the only thing that rewrites the expression, so
  // switching to the builder never silently replaces a schedule it could not
  // read in the first place.
  const applyBuilder = (patch: Partial<CronBuilderState>) => {
    const next = { ...builder, ...patch };
    setBuilder(next);
    setForm((current) => ({ ...current, cron: buildCron(next) }));
  };
  const builderMatchesExpression = buildCron(builder) === form.cron.trim();

  const channels = channelData?.channels ?? [];
  const payload = useMemo(() => ({
    name: form.name.trim(),
    description: form.description.trim(),
    enabled: form.enabled,
    schedule: { cron: form.cron.trim(), timezone: form.timezone.trim() },
    scriptSource: form.scriptSource,
    scriptTimeoutMs: form.scriptTimeoutSeconds * 1000
  }), [form]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["automation"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) return api.post<{ id: string; version: number }>("/api/automation/rules", { key: form.key.trim(), ...payload });
      // Saving from an older version restores it: what is in the editor is
      // what becomes the next version.
      return api.patch<{ success: boolean; version: number | null; versionCreated: boolean }>(`/api/automation/rules/${ruleId}`, { ...payload, scriptSource: editorValue });
    },
    onSuccess: async (result) => {
      await invalidate();
      const savedVersion = (result as { version?: number | null }).version ?? null;
      const createdVersion = (result as { versionCreated?: boolean }).versionCreated ?? isNew;
      setLoadedRuleId(null);
      setSelectedVersion(createdVersion ? savedVersion : selectedVersion);
      toast.success(isNew
        ? "Automation rule created"
        : createdVersion && savedVersion !== null
          ? `Saved as version ${savedVersion}`
          : "Automation rule saved");
      if (isNew) onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save the rule")
  });

  const run = useMutation({
    mutationFn: () => api.post<AutomationRun & { runId: string; status: string; scriptVersion: number; sequence: number }>(`/api/automation/rules/${ruleId}/run`, {}),
    onSuccess: async (result) => {
      await invalidate();
      setExpandedRunId(result.runId);
      setRunPage(1);
      const label = `Run #${result.sequence} ${result.status.replaceAll("_", " ")} · version ${result.scriptVersion}`;
      if (result.status === "succeeded") toast.success(label);
      else toast.error(label);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to run the rule")
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ success: boolean }>(`/api/automation/rules/${ruleId}`),
    onSuccess: async () => {
      setDeleteOpen(false);
      await invalidate();
      toast.success("Automation rule deleted");
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete the rule")
  });

  const canSave = form.name.trim().length > 0
    && form.scriptSource.trim().length > 0
    && form.cron.trim().length > 0
    && !cronInvalid
    && (!isNew || /^[a-z0-9][a-z0-9_-]*$/.test(form.key.trim()));

  const title = <div className="drawer-heading">
    <strong>{isNew ? "New automation rule" : form.name || "Automation rule"}</strong>
    {!isNew && <code className="automation-key-chip">{form.key}</code>}
    {!isNew && latestVersion !== null && <code className="automation-key-chip">v{latestVersion}</code>}
    {!isNew && ruleData?.rule.lastRunStatus && <StatusBadge status={ruleData.rule.lastRunStatus} />}
  </div>;

  return <SideDrawer open title={title} focusKey={ruleId ?? "new-automation-rule"} onClose={onClose} width={width} onResize={onResize}>
    <div className="automation-drawer">
      <section className="automation-section">
        <header><h3>Identity</h3><span>The key is how MCP tools and logs refer to this rule.</span></header>
        <div className="automation-identity-grid">
          <label className="field"><span className="field-label">Key <FieldHelp text="Lowercase letters, digits, hyphen, or underscore. Set once at creation and never changed, because run history and MCP tools address the rule by it." /></span><input value={form.key} disabled={!isNew} placeholder="daily-health-report" onChange={(event) => setForm((current) => ({ ...current, key: event.target.value.toLowerCase() }))} /></label>
          <label className="field"><span className="field-label">Name</span><input value={form.name} placeholder="Daily health report" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
          <label className="field"><span className="field-label">Description</span><input value={form.description} placeholder="Optional description" onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
          <label className="switch-control automation-enabled-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} /><span /><strong>{form.enabled ? "Enabled" : "Disabled"}</strong></label>
        </div>
      </section>

      <section className="automation-section">
        <header><h3>Schedule</h3><span>A cron timer is what starts the script; everything after that is the script itself.</span></header>
        <div className="automation-mode-switch" role="tablist" aria-label="Schedule editing mode">
          <button type="button" role="tab" aria-selected={scheduleMode === "builder"} className={scheduleMode === "builder" ? "active" : undefined} onClick={() => setScheduleMode("builder")}><Wand2 size={14} />Builder</button>
          <button type="button" role="tab" aria-selected={scheduleMode === "expression"} className={scheduleMode === "expression" ? "active" : undefined} onClick={() => setScheduleMode("expression")}><Code2 size={14} />Expression</button>
        </div>

        {scheduleMode === "builder"
          ? <div className="automation-builder">
            <label className="field automation-builder-frequency"><span className="field-label">Run</span>
              <select value={builder.frequency} onChange={(event) => applyBuilder({ frequency: event.target.value as CronFrequency })}>
                <option value="minutes">Every few minutes</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            {builder.frequency === "minutes" && <label className="field"><span className="field-label">Every (minutes)</span><input type="number" min={1} max={59} value={builder.everyMinutes} onChange={(event) => applyBuilder({ everyMinutes: Math.min(59, Math.max(1, Number(event.target.value) || 1)) })} /></label>}
            {builder.frequency === "hourly" && <label className="field"><span className="field-label">At minute</span><input type="number" min={0} max={59} value={builder.minute} onChange={(event) => applyBuilder({ minute: Math.min(59, Math.max(0, Number(event.target.value) || 0)) })} /></label>}
            {builder.frequency === "monthly" && <label className="field"><span className="field-label">Day of month <FieldHelp text="A day past the end of a short month is simply skipped that month: 31 runs in January but not in February." /></span><input type="number" min={1} max={31} value={builder.dayOfMonth} onChange={(event) => applyBuilder({ dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value) || 1)) })} /></label>}
            {["daily", "weekly", "monthly"].includes(builder.frequency) && <label className="field"><span className="field-label">At time</span><input type="time" value={timeValue(builder)} onChange={(event) => { const parsed = parseTimeValue(event.target.value); if (parsed) applyBuilder(parsed); }} /></label>}
            {builder.frequency === "weekly" && <div className="field automation-builder-weekdays"><span className="field-label">On days</span>
              <div className="automation-weekday-chips">{WEEKDAYS.map((day) => <button
                key={day.value}
                type="button"
                aria-pressed={builder.weekdays.includes(day.value)}
                className={builder.weekdays.includes(day.value) ? "active" : undefined}
                onClick={() => applyBuilder({ weekdays: builder.weekdays.includes(day.value) ? builder.weekdays.filter((value) => value !== day.value) : [...builder.weekdays, day.value] })}
              >{day.label}</button>)}</div>
            </div>}
            <div className="field automation-builder-result"><span className="field-label">Expression</span><code>{form.cron}</code></div>
          </div>
          : <label className="field"><span className="field-label">Cron expression <FieldHelp text="Five fields: minute hour day-of-month month day-of-week. A sixth field is read as seconds and goes first: second minute hour day-of-month month day-of-week." /></span><input value={form.cron} onChange={(event) => setForm((current) => ({ ...current, cron: event.target.value }))} placeholder="*/15 * * * *" /></label>}

        {scheduleMode === "builder" && !builderMatchesExpression && <div className="automation-cron-note">The saved expression <code>{form.cron}</code> is more specific than the builder can show. Change anything here and it will be replaced.</div>}

        <div className="automation-trigger-grid">
          <label className="field"><span className="field-label">Time zone <FieldHelp text="The IANA time zone the expression is written in. The schedule keeps that local meaning across daylight-saving changes." /></span><input value={form.timezone} onChange={(event) => setForm((current) => ({ ...current, timezone: event.target.value }))} placeholder={capabilities?.defaultTimezone ?? "UTC"} /></label>
          <label className="field"><span className="field-label">Script timeout (seconds) <FieldHelp text="Hard limit for the script and its context calls. When it passes, the worker running the script is terminated and the run is recorded as timed out." /></span><input type="number" min={1} max={600} value={form.scriptTimeoutSeconds} onChange={(event) => setForm((current) => ({ ...current, scriptTimeoutSeconds: Math.min(600, Math.max(1, Number(event.target.value) || 1)) }))} /></label>
        </div>
        {cronInvalid
          ? <div className="automation-cron-error">{cronError instanceof Error ? cronError.message : "Invalid schedule"}</div>
          : <div className="automation-cron-preview">
            <div className="automation-cron-explain"><CalendarClock size={14} /><strong>{cronPreview?.description ?? "Reading the expression..."}</strong><span>{form.timezone || capabilities?.defaultTimezone}</span></div>
            <div className="automation-cron-next"><span>Next runs</span>{(cronPreview?.nextRuns ?? []).map((next) => <code key={next}>{new Date(next).toLocaleString()}</code>)}</div>
          </div>}
      </section>

      <section className="automation-section">
        <header><h3>Script</h3><span>Does the whole rule: inspects, acts, sends through cfman.sendMessage, and returns what the run history should show.</span></header>
        {versions.length > 0 && <div className="script-version-timeline">{versions.map((entry) => <button
          key={entry.id}
          type="button"
          title={`Version ${entry.version} · ${entry.createdBy ?? "system"} · ${new Date(entry.createdAt).toLocaleString()}`}
          className={`script-version-item ${entry.version === selectedVersion ? "active" : ""}`}
          onClick={() => setSelectedVersion(entry.version)}
        >
          <span className="script-version-dot" />
          <span className="script-version-meta">
            <strong>Version {entry.version}{entry.version === latestVersion && <span className="script-version-latest-tag">Latest</span>}</strong>
            <span>{entry.createdBy ?? "system"} · {new Date(entry.createdAt).toLocaleString()}</span>
          </span>
        </button>)}</div>}
        <ScriptEditor
          value={editorValue}
          language="javascript"
          height="420px"
          readOnly={!viewingLatest}
          typeDefinitions={capabilities?.typeDefinitions}
          onChange={(value) => setForm((current) => ({ ...current, scriptSource: value }))}
        />
        {!isNew && <div className="script-editor-hint-row"><span className="script-editor-hint">{editorValue === latestSource
          ? "No script changes"
          : viewingLatest
            ? `Saving creates version ${(latestVersion ?? 0) + 1}`
            : `Saving restores version ${selectedVersion} as version ${(latestVersion ?? 0) + 1}`}</span></div>}
        <details className="automation-context-help">
          <summary>Available context calls</summary>
          <ul>{(capabilities?.context ?? []).map((entry) => <li key={entry.signature}><code>{entry.signature}</code><span>{entry.description}</span></li>)}</ul>
        </details>
        {channels.length > 0 && <div className="automation-channel-keys">
          <span>Channel keys</span>
          {channels.map((channel) => <code key={channel.key} title={`${channel.name} · ${channel.target}${channel.supportsButtons ? ` · buttons: up to ${channel.maxButtons}` : " · messages only"}`}>{channel.key}{channel.supportsButtons ? " ⏎" : ""}</code>)}
          <span className="automation-channel-keys-hint">⏎ can also be asked with cfman.ask</span>
        </div>}
      </section>

      <div className="form-actions automation-form-actions">
        {!isNew && <button className="button button-danger" type="button" onClick={() => setDeleteOpen(true)}><Trash2 size={15} />Delete</button>}
        {!isNew && <button className="button button-secondary" type="button" disabled={run.isPending} onClick={() => run.mutate()}><Play size={15} />{run.isPending ? "Running..." : "Run now"}</button>}
        <button className="button button-primary" type="button" disabled={!canSave || save.isPending} onClick={() => save.mutate()}><Save size={15} />{save.isPending ? "Saving..." : isNew ? "Create rule" : "Save changes"}</button>
      </div>

      {!isNew && <section className="automation-section">
        <header><h3>Run history</h3><span>{runData?.pagination.total ?? 0} run(s)</span></header>
        {focusedRunId && <div className="execution-focus-note"><span>Showing one run opened from a script execution.</span><button className="button button-secondary button-small" type="button" onClick={() => { setFocusedRunId(null); setRunPage(1); }}>Show full history</button></div>}
        <div className="table-scroll"><table><thead><tr><th>Run</th><th>Started</th><th>Trigger</th><th>Version</th><th>Status</th><th>Result</th><th>Elapsed</th></tr></thead><tbody>
          {(runData?.runs ?? []).length === 0
            ? <tr><td colSpan={7}><div className="quiet-empty">This rule has not run yet.</div></td></tr>
            : runData!.runs.map((item) => <Fragment key={item.id}>
              <tr className="data-row" tabIndex={0} onClick={() => setExpandedRunId(expandedRunId === item.id ? null : item.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setExpandedRunId(expandedRunId === item.id ? null : item.id); } }}>
                <td><code className="automation-run-sequence">#{item.sequence}</code></td>
                <td>{formatTimestamp(item.startedAt)}</td>
                <td>{item.trigger}</td>
                <td>{item.scriptVersion === null ? "—" : <button type="button" className="automation-run-version-link" onClick={(event) => { event.stopPropagation(); setSelectedVersion(item.scriptVersion); }}>v{item.scriptVersion}</button>}</td>
                <td><StatusBadge status={item.status} /></td>
                <td className="automation-run-summary-cell">{item.error ?? (item.outputBody.split("\n")[0] || "—")}</td>
                <td>{item.elapsedMs === null ? "—" : `${(item.elapsedMs / 1000).toFixed(1)}s`}</td>
              </tr>
              {expandedRunId === item.id && <tr><td colSpan={7}>
                <div className="automation-run-detail">
                  {item.error && <div className="automation-run-error">{item.error}</div>}
                  <div className="automation-run-block">
                    <header><strong>Output</strong><code>{item.outputMimeType ?? "—"}</code>{item.outputTruncated && <span>truncated</span>}</header>
                    <pre>{item.outputBody || "(empty)"}</pre>
                  </div>
                  {runActivity(item).length > 0 && <div className="automation-run-block">
                    <header><strong>What the run did</strong><span>{runActivity(item).length} action(s), oldest first</span></header>
                    <ol className="automation-run-activity">{runActivity(item).map((entry) => <li key={entry.key}>
                      <time>{new Date(entry.at).toLocaleTimeString()}</time>
                      {entry.kind === "execution"
                        ? <>
                          <StatusBadge status={entry.execution.status} />
                          <div className="automation-run-activity-main">
                            <span className="automation-run-activity-title">
                              Ran <strong>{entry.execution.scriptName}</strong>{entry.execution.scriptVersion === null ? "" : ` · v${entry.execution.scriptVersion}`} on
                              <button
                                type="button"
                                className="automation-run-version-link"
                                title="Open this execution's log in the tunnel drawer"
                                onClick={(event) => { event.stopPropagation(); openTunnelDrawer(entry.execution.tunnelId, "connect", { executionId: entry.execution.id }); }}
                              >{entry.execution.tunnelDisplayName}</button>
                            </span>
                            <span className="automation-run-prompt-meta">{entry.execution.tenantCode} / {entry.execution.tunnelCode}{entry.execution.exitCode === null ? "" : ` · exit ${entry.execution.exitCode}`}{entry.execution.elapsedMs === null ? "" : ` · ${entry.execution.elapsedMs} ms`}</span>
                          </div>
                        </>
                        : <>
                          <StatusBadge
                            status={entry.prompt.status === "answered" ? "succeeded" : entry.prompt.status === "timed_out" ? "timed_out" : entry.prompt.status === "pending" ? "running" : "failed"}
                            label={entry.prompt.status === "answered" ? entry.prompt.answerLabel ?? "answered" : entry.prompt.status.replaceAll("_", " ")}
                          />
                          <div className="automation-run-activity-main">
                            <span className="automation-run-activity-title">Asked <strong>{entry.prompt.body}</strong></span>
                            <span className="automation-run-prompt-meta">{entry.prompt.channelKey}{entry.prompt.answeredBy ? ` · ${entry.prompt.answeredBy}` : ""}{entry.prompt.error ? ` · ${entry.prompt.error}` : ""}</span>
                          </div>
                        </>}
                    </li>)}</ol>
                  </div>}
                  {item.logs.length > 0 && <div className="automation-run-block">
                    <header><strong>Console</strong></header>
                    <pre className="automation-run-logs">{item.logs.map((log) => `${new Date(log.at).toLocaleTimeString()} ${log.level === "log" ? "" : `${log.level}: `}${log.message}`).join("\n")}</pre>
                  </div>}
                </div>
              </td></tr>}
            </Fragment>)}
        </tbody></table></div>
        {runData && runData.pagination.totalPages > 1 && <div className="table-pagination"><span>{runData.pagination.total} total</span><div>
          <button className="icon-button" type="button" title="Previous page" aria-label="Previous run page" disabled={runPage <= 1} onClick={() => setRunPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button>
          <span>Page {runPage} of {runData.pagination.totalPages}</span>
          <button className="icon-button" type="button" title="Next page" aria-label="Next run page" disabled={runPage >= runData.pagination.totalPages} onClick={() => setRunPage((page) => page + 1)}><ChevronRight size={15} /></button>
        </div></div>}
      </section>}
    </div>

    <Modal open={deleteOpen} title="Delete automation rule" onClose={() => setDeleteOpen(false)}>
      <div className="delete-confirmation">
        <p>Deleting <strong>{form.name}</strong> also deletes its run history. Messages already sent are kept in the channel's log.</p>
        <div className="form-actions">
          <button className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button>
          <button className="button button-danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={15} />{remove.isPending ? "Deleting..." : "Delete rule"}</button>
        </div>
      </div>
    </Modal>
  </SideDrawer>;
}
