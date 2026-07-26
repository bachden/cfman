import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Globe2, KeyRound, LogOut, RefreshCw, Save, ServerCog, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../api";
import { CopyButton } from "../components/CopyButton";
import { FieldHelp } from "../components/FieldHelp";
import { AddVariableButton, ExecutionVariablesEditor } from "../components/ExecutionVariablesEditor";
import { PageHeader } from "../components/PageHeader";
import type { AppSettings, ExecutionVariables, User } from "../types";

type McpSettingsResponse = {
  settings: AppSettings["mcp"];
  token?: string;
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function SettingsPage({ user, onLogout, onPasswordChanged }: { user: User; onLogout: () => void; onPasswordChanged: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [globalVariables, setGlobalVariables] = useState<ExecutionVariables>({});
  const { data: settingsData, isLoading: settingsLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: AppSettings }>("/api/settings")
  });
  const updateSettings = useMutation({
    mutationFn: (body: Pick<AppSettings, "publicBaseUrl">) => api.put<{ settings: AppSettings }>("/api/settings", body),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      setSettingsError("");
      toast.success("Public base URL updated");
    },
    onError: (requestError) => setSettingsError(requestError instanceof ApiError ? requestError.message : "Unable to update public base URL")
  });
  const updateMcp = useMutation({
    mutationFn: (enabled: boolean) => api.patch<McpSettingsResponse>("/api/settings/mcp", { enabled }),
    onSuccess: (data) => {
      queryClient.setQueryData<{ settings: AppSettings }>(["settings"], (current) => current ? { settings: { ...current.settings, mcp: data.settings } } : current);
      setMcpToken(data.token ?? null);
      toast.success(data.settings.enabled ? "MCP server enabled" : "MCP server disabled");
    },
    onError: (requestError) => toast.error(requestError instanceof ApiError ? requestError.message : "Unable to update MCP server")
  });
  useEffect(() => { if (settingsData?.settings.executionVariables) setGlobalVariables(settingsData.settings.executionVariables); }, [settingsData?.settings.executionVariables]);
  const updateExecutionVariables = useMutation({
    mutationFn: () => api.put<{ variables: ExecutionVariables }>("/api/settings/execution-variables", { variables: globalVariables }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Global execution variables updated");
    },
    onError: (requestError) => toast.error(requestError instanceof Error ? requestError.message : "Unable to update global execution variables")
  });
  const rotateMcp = useMutation({
    mutationFn: () => api.post<McpSettingsResponse>("/api/settings/mcp/rotate"),
    onSuccess: (data) => {
      queryClient.setQueryData<{ settings: AppSettings }>(["settings"], (current) => current ? { settings: { ...current.settings, mcp: data.settings } } : current);
      setMcpToken(data.token ?? null);
      toast.success("MCP token rotated");
    },
    onError: (requestError) => toast.error(requestError instanceof ApiError ? requestError.message : "Unable to rotate MCP token")
  });
  const changePassword = useMutation({
    mutationFn: (body: unknown) => api.post("/api/auth/change-password", body),
    onSuccess: () => { toast.success("Password changed"); onPasswordChanged(); setError(""); },
    onError: (requestError) => setError(requestError instanceof ApiError ? requestError.message : "Unable to change password")
  });
  const mcp = settingsData?.settings.mcp;
  const mcpConfig = useMemo(() => JSON.stringify({
    mcpServers: {
      "cloudflare-man": {
        type: "http",
        url: mcp?.endpoint ?? "https://cloudflare-man.example.com/mcp",
        headers: { Authorization: "Bearer ${CLOUDFLARE_MAN_MCP_TOKEN}" }
      }
    }
  }, null, 2), [mcp?.endpoint]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = form.get("currentPassword")?.toString() ?? "";
    const newPassword = form.get("newPassword")?.toString() ?? "";
    const confirmPassword = form.get("confirmPassword")?.toString() ?? "";
    if (newPassword !== confirmPassword) { setError("New passwords do not match"); return; }
    changePassword.mutate({ currentPassword, newPassword });
  };
  const submitSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    updateSettings.mutate({ publicBaseUrl: form.get("publicBaseUrl")?.toString() ?? "" });
  };
  const logout = async () => { await api.post("/api/auth/logout"); queryClient.clear(); onLogout(); };

  return <div className="page settings-page">
    <PageHeader title="Settings" eyebrow="System and security" />
    <section className="settings-section">
      <header><span><Globe2 size={19} /></span><div><h2>Public access</h2></div></header>
      <form className="settings-form" key={settingsData?.settings.publicBaseUrl} onSubmit={submitSettings}>
        {settingsError && <div className="form-error">{settingsError}</div>}
        <label className="field"><span className="field-label">Public base URL <FieldHelp text="The HTTPS origin reachable from store machines. Enrollment commands, installer callback URLs, and the MCP endpoint use this value. Enter a full origin without a path." /></span><input name="publicBaseUrl" defaultValue={settingsData?.settings.publicBaseUrl ?? ""} placeholder="https://cloudflare-man.example.com" disabled={settingsLoading} required /></label>
        <button className="button button-primary" disabled={settingsLoading || updateSettings.isPending}><Save size={15} />{updateSettings.isPending ? "Saving..." : "Save URL"}</button>
      </form>
    </section>

    <section className="settings-section execution-variable-settings-section">
      <header><span><Braces size={19} /></span><div className="settings-heading-copy"><h2>Global execution variables</h2><small>Inherited by every saved and inline script execution. Account, zone, store, computer, and run overrides take precedence.</small></div></header>
      <div className="settings-form execution-variable-settings-body"><ExecutionVariablesEditor variables={globalVariables} savedVariables={settingsData?.settings.executionVariables ?? {}} onChange={setGlobalVariables} /><div className="form-actions"><AddVariableButton variables={globalVariables} onChange={setGlobalVariables} /><button className="button button-primary" type="button" disabled={settingsLoading || updateExecutionVariables.isPending} onClick={() => updateExecutionVariables.mutate()}><Save size={15} />{updateExecutionVariables.isPending ? "Saving..." : "Save variables"}</button></div></div>
    </section>

    <section className="settings-section mcp-settings-section">
      <header>
        <span><ServerCog size={19} /></span>
        <div className="settings-heading-copy"><h2>MCP server</h2><small>Expose Cloudflare Man data and administrative operations to trusted MCP clients.</small></div>
        <label className="switch-control">
          <input type="checkbox" checked={mcp?.enabled ?? false} disabled={!mcp || updateMcp.isPending} onChange={(event) => updateMcp.mutate(event.target.checked)} />
          <span aria-hidden="true" />
          <strong>{mcp?.enabled ? "Enabled" : "Disabled"}</strong>
        </label>
      </header>
      <div className="mcp-settings-body">
        <dl className="mcp-metadata">
          <div><dt>Endpoint</dt><dd><code>{mcp?.endpoint ?? "Loading..."}</code>{mcp?.endpoint && <CopyButton value={mcp.endpoint} />}</dd></div>
          <div><dt>Token</dt><dd>{mcp?.tokenHint ? <code>{mcp.tokenHint}</code> : "Not issued"}</dd></div>
          <div><dt>Last used</dt><dd>{formatDate(mcp?.lastUsedAt ?? null)}</dd></div>
          <div><dt>Last rotated</dt><dd>{formatDate(mcp?.rotatedAt ?? null)}</dd></div>
        </dl>
        {mcpToken && <div className="mcp-secret-panel">
          <div><strong>Save this token now</strong><span>It is shown only once. Rotating it immediately invalidates the previous token.</span></div>
          <div className="mcp-secret-value"><code>{mcpToken}</code><CopyButton value={mcpToken} label="Copy token" /></div>
        </div>}
        <div className="mcp-actions">
          <button className="button button-secondary" type="button" disabled={!mcp?.enabled || rotateMcp.isPending} onClick={() => rotateMcp.mutate()}><RefreshCw size={15} />{rotateMcp.isPending ? "Rotating..." : "Rotate token"}</button>
          <span>Bearer tokens grant full administrator access through MCP.</span>
        </div>
        <div className="mcp-helper">
          <div><strong>Client configuration</strong><span>Use Streamable HTTP transport and pass the token in the Authorization header.</span></div>
          <div className="mcp-config-head"><code>CLOUDFLARE_MAN_MCP_TOKEN={mcpToken ?? "<token shown after enable or rotate>"}</code><CopyButton value={mcpConfig} label="Copy config" /></div>
          <pre><code>{mcpConfig}</code></pre>
        </div>
      </div>
    </section>

    <section className="settings-section">
      <header><span><ShieldCheck size={19} /></span><div><h2>Administrator account</h2></div></header>
      <dl className="account-profile"><div><dt>Username</dt><dd>{user.username}</dd></div><div><dt>Role</dt><dd>Administrator</dd></div><div><dt>Password status</dt><dd>{user.mustChangePassword ? <span className="warning-text">Change required</span> : "Current"}</dd></div></dl>
    </section>
    <section className="settings-section">
      <header><span><KeyRound size={19} /></span><div><h2>Change password</h2></div></header>
      <form className="password-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <label className="field"><span className="field-label">Current password <FieldHelp text="The password currently used to sign in to this Cloudflare Man administrator account." /></span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
        <label className="field"><span className="field-label">New password <FieldHelp text="The new local administrator password. It must contain at least 10 characters and is unrelated to your Cloudflare credentials." /></span><input name="newPassword" type="password" autoComplete="new-password" minLength={10} required /></label>
        <label className="field"><span className="field-label">Confirm new password <FieldHelp text="Enter the new password again to prevent an accidental typo before it replaces the current password." /></span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required /></label>
        <button className="button button-primary" disabled={changePassword.isPending}>{changePassword.isPending ? "Updating..." : "Update password"}</button>
      </form>
    </section>
    <section className="settings-section danger-section"><div><h2>Current session</h2><span>Signed in as {user.username}</span></div><button className="button button-danger" onClick={() => void logout()}><LogOut size={16} />Sign out</button></section>
  </div>;
}
