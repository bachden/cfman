import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Globe2, KeyRound, LogOut, RefreshCw, Save, ServerCog, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../api";
import { CopyButton } from "../components/CopyButton";
import { FieldHelp } from "../components/FieldHelp";
import { AddVariableButton, ExecutionVariablesEditor } from "../components/ExecutionVariablesEditor";
import { PageHeader } from "../components/PageHeader";
import { BRAND_ICON_COMPONENTS, BRAND_ICON_OPTIONS } from "../components/brand-icons";
import type { AppSettings, Branding, ExecutionVariables, User } from "../types";

type McpSettingsResponse = {
  settings: AppSettings["mcp"];
  token?: string;
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

// Written literally into the snippets. Clients that expand environment variables
// resolve it; the others carry a note telling the operator to paste the token in.
const MCP_TOKEN_REF = "${CFMAN_MCP_TOKEN}";

type McpClientId = "claude-code" | "claude-desktop" | "codex" | "gemini-cli" | "cursor" | "vscode";

type McpClientProfile = {
  id: McpClientId;
  label: string;
  transport: string;
  windowsPath: string;
  macosPath: string;
  notes: string[];
  buildConfig: (endpoint: string) => string;
};

const MCP_CLIENTS: McpClientProfile[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    transport: "Streamable HTTP (native)",
    windowsPath: "%USERPROFILE%\\.claude.json  -  or .mcp.json in the project root",
    macosPath: "~/.claude.json  -  or .mcp.json in the project root",
    notes: [
      "Expands ${VAR} from the environment, so exporting CFMAN_MCP_TOKEN keeps the token out of the file.",
      "Equivalent CLI: claude mcp add --transport http cfman <endpoint> --header \"Authorization: Bearer $CFMAN_MCP_TOKEN\"",
      "Use .mcp.json to share the server with a repository, or ~/.claude.json to keep it to your user account."
    ],
    buildConfig: (endpoint) => JSON.stringify({
      mcpServers: { "cfman": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${MCP_TOKEN_REF}` } } }
    }, null, 2)
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop (stdio only)",
    transport: "stdio, bridged to HTTP by mcp-remote",
    windowsPath: "%APPDATA%\\Claude\\claude_desktop_config.json",
    macosPath: "~/Library/Application Support/Claude/claude_desktop_config.json",
    notes: [
      "Claude Desktop speaks stdio only, so mcp-remote proxies the Streamable HTTP endpoint. Node.js 18+ must be installed.",
      "Environment variables are not expanded here - replace ${CFMAN_MCP_TOKEN} with the token value.",
      "Quit Claude Desktop completely and reopen it; closing the window alone does not reload the config."
    ],
    buildConfig: (endpoint) => JSON.stringify({
      mcpServers: { "cfman": { command: "npx", args: ["-y", "mcp-remote", endpoint, "--header", `Authorization: Bearer ${MCP_TOKEN_REF}`] } }
    }, null, 2)
  },
  {
    id: "codex",
    label: "Codex CLI",
    transport: "Streamable HTTP (native)",
    windowsPath: "%USERPROFILE%\\.codex\\config.toml",
    macosPath: "~/.codex/config.toml",
    notes: [
      "Codex uses TOML, not JSON - append the block to the existing config.toml instead of replacing the file.",
      "Headers go under http_headers, not the headers key used by the JSON clients.",
      "Replace ${CFMAN_MCP_TOKEN} with the token value."
    ],
    buildConfig: (endpoint) => `[mcp_servers.cfman]
url = "${endpoint}"
http_headers = { Authorization = "Bearer ${MCP_TOKEN_REF}" }`
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    transport: "Streamable HTTP (native)",
    windowsPath: "%USERPROFILE%\\.gemini\\settings.json",
    macosPath: "~/.gemini/settings.json",
    notes: [
      "httpUrl selects Streamable HTTP. The url key would make Gemini CLI use SSE instead.",
      "Expands ${VAR} from the environment.",
      "A .gemini/settings.json inside the project overrides the user-level file."
    ],
    buildConfig: (endpoint) => JSON.stringify({
      mcpServers: { "cfman": { httpUrl: endpoint, headers: { Authorization: `Bearer ${MCP_TOKEN_REF}` } } }
    }, null, 2)
  },
  {
    id: "cursor",
    label: "Cursor",
    transport: "Streamable HTTP (native)",
    windowsPath: "%USERPROFILE%\\.cursor\\mcp.json  -  or .cursor\\mcp.json in the project",
    macosPath: "~/.cursor/mcp.json  -  or .cursor/mcp.json in the project",
    notes: [
      "Replace ${CFMAN_MCP_TOKEN} with the token value.",
      "Reload the MCP server from Cursor Settings > MCP after saving."
    ],
    buildConfig: (endpoint) => JSON.stringify({
      mcpServers: { "cfman": { url: endpoint, headers: { Authorization: `Bearer ${MCP_TOKEN_REF}` } } }
    }, null, 2)
  },
  {
    id: "vscode",
    label: "VS Code (Copilot)",
    transport: "Streamable HTTP (native)",
    windowsPath: ".vscode\\mcp.json in the workspace",
    macosPath: ".vscode/mcp.json in the workspace",
    notes: [
      "VS Code uses the servers key, not mcpServers.",
      "Prefer an input prompt over a literal token so it is not committed with the workspace."
    ],
    buildConfig: (endpoint) => JSON.stringify({
      servers: { "cfman": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${MCP_TOKEN_REF}` } } }
    }, null, 2)
  }
];

export function SettingsPage({ user, onLogout, onPasswordChanged }: { user: User; onLogout: () => void; onPasswordChanged: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [mcpClient, setMcpClient] = useState<McpClientId>("claude-code");
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
  const [branding, setBranding] = useState<Branding | null>(null);
  useEffect(() => { if (settingsData?.settings.branding) setBranding(settingsData.settings.branding); }, [settingsData?.settings.branding]);
  const updateBranding = useMutation({
    mutationFn: () => api.put<{ branding: Branding }>("/api/settings/branding", branding),
    onSuccess: (data) => {
      queryClient.setQueryData<{ settings: AppSettings }>(["settings"], (current) => current ? { settings: { ...current.settings, branding: data.branding } } : current);
      toast.success("Branding updated");
    },
    onError: (requestError) => toast.error(requestError instanceof ApiError ? requestError.message : "Unable to update branding")
  });
  const updateExecutionVariables = useMutation({
    mutationFn: () => api.put<{ variables: ExecutionVariables }>("/api/settings/execution-variables", { variables: globalVariables }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Global environment variables updated");
    },
    onError: (requestError) => toast.error(requestError instanceof Error ? requestError.message : "Unable to update global environment variables")
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
  const mcpClientProfile = MCP_CLIENTS.find((client) => client.id === mcpClient) ?? MCP_CLIENTS[0]!;
  const mcpConfig = useMemo(
    () => mcpClientProfile.buildConfig(mcp?.endpoint ?? "https://cfman.example.com/mcp"),
    [mcpClientProfile, mcp?.endpoint]
  );
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
  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      onLogout();
      window.location.assign("/");
    }
  };

  return <div className="page settings-page">
    <PageHeader title="Settings" eyebrow="System and security" />
    <section className="settings-section">
      <header><span><Globe2 size={19} /></span><div><h2>Public access</h2></div></header>
      <form className="settings-form" key={settingsData?.settings.publicBaseUrl} onSubmit={submitSettings}>
        {settingsError && <div className="form-error">{settingsError}</div>}
        <label className="field"><span className="field-label">Public base URL <FieldHelp text="The HTTPS origin reachable from tunnel machines. Enrollment commands, installer callback URLs, and the MCP endpoint use this value. Enter a full origin without a path." /></span><input name="publicBaseUrl" defaultValue={settingsData?.settings.publicBaseUrl ?? ""} placeholder="https://cfman.example.com" disabled={settingsLoading} required /></label>
        <button className="button button-primary" disabled={settingsLoading || updateSettings.isPending}><Save size={15} />{updateSettings.isPending ? "Saving..." : "Save URL"}</button>
      </form>
    </section>

    <section className="settings-section">
      <header><span><Sparkles size={19} /></span><div><h2>Branding</h2></div></header>
      <div className="settings-form branding-settings-form">
        <div className="branding-icon-picker">
          {BRAND_ICON_OPTIONS.map((option) => {
            const OptionIcon = BRAND_ICON_COMPONENTS[option];
            return <button key={option} type="button" className={`branding-icon-option ${branding?.icon === option ? "active" : ""}`} aria-label={`Use ${option} icon`} aria-pressed={branding?.icon === option} onClick={() => setBranding((current) => current ? { ...current, icon: option } : current)}><OptionIcon size={17} /></button>;
          })}
        </div>
        <label className="field"><span className="field-label">Title <FieldHelp text="Shown next to the icon at the top of the sidebar on every page. Keep it short." /></span><input value={branding?.title ?? ""} maxLength={40} onChange={(event) => setBranding((current) => current ? { ...current, title: event.target.value } : current)} placeholder="CFMan" /></label>
        <label className="field"><span className="field-label">Subtitle <FieldHelp text="A short tagline shown under the title in the sidebar." /></span><input value={branding?.subtitle ?? ""} maxLength={80} onChange={(event) => setBranding((current) => current ? { ...current, subtitle: event.target.value } : current)} placeholder="Easy Cloudflare tunnels" /></label>
        <div className="form-actions"><button className="button button-primary" type="button" disabled={!branding || updateBranding.isPending} onClick={() => updateBranding.mutate()}><Save size={15} />{updateBranding.isPending ? "Saving..." : "Save branding"}</button></div>
      </div>
    </section>

    <section className="settings-section execution-variable-settings-section">
      <header><span><Braces size={19} /></span><div className="settings-heading-copy"><h2>Global environment variables</h2><small>Inherited by every saved and inline script execution. Account, zone, tunnel, computer, and run overrides take precedence.</small></div></header>
      <div className="settings-form execution-variable-settings-body"><ExecutionVariablesEditor variables={globalVariables} savedVariables={settingsData?.settings.executionVariables ?? {}} onChange={setGlobalVariables} /><div className="form-actions"><AddVariableButton variables={globalVariables} onChange={setGlobalVariables} /><button className="button button-primary" type="button" disabled={settingsLoading || updateExecutionVariables.isPending} onClick={() => updateExecutionVariables.mutate()}><Save size={15} />{updateExecutionVariables.isPending ? "Saving..." : "Save variables"}</button></div></div>
    </section>

    <section className="settings-section mcp-settings-section">
      <header>
        <span><ServerCog size={19} /></span>
        <div className="settings-heading-copy"><h2>MCP server</h2><small>Expose CFMan data and administrative operations to trusted MCP clients.</small></div>
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
          <div><strong>Client configuration</strong><span>Pick the agent you use to get its snippet, config file, and transport.</span></div>
          <div className="mcp-client-picker">
            <label className="field">
              <span className="field-label">AI agent <FieldHelp text="Each client tunnels MCP servers in its own file and format. Clients without native Streamable HTTP support are bridged through mcp-remote, which requires Node.js on the machine running the agent." /></span>
              <select value={mcpClient} onChange={(event) => setMcpClient(event.target.value as McpClientId)}>
                {MCP_CLIENTS.map((client) => <option key={client.id} value={client.id}>{client.label}</option>)}
              </select>
            </label>
            <dl className="mcp-client-paths">
              <div><dt>Transport</dt><dd>{mcpClientProfile.transport}</dd></div>
              <div><dt>Windows</dt><dd><code>{mcpClientProfile.windowsPath}</code></dd></div>
              <div><dt>macOS</dt><dd><code>{mcpClientProfile.macosPath}</code></dd></div>
            </dl>
          </div>
          <div className="mcp-config-head"><code>CFMAN_MCP_TOKEN={mcpToken ?? "<token shown after enable or rotate>"}</code><CopyButton value={mcpConfig} label="Copy config" /></div>
          <pre><code>{mcpConfig}</code></pre>
          <ul className="mcp-client-notes">{mcpClientProfile.notes.map((note) => <li key={note}>{note}</li>)}</ul>
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
        <label className="field"><span className="field-label">Current password <FieldHelp text="The password currently used to sign in to this CFMan administrator account." /></span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
        <label className="field"><span className="field-label">New password <FieldHelp text="The new local administrator password. It must contain at least 10 characters and is unrelated to your Cloudflare credentials." /></span><input name="newPassword" type="password" autoComplete="new-password" minLength={10} required /></label>
        <label className="field"><span className="field-label">Confirm new password <FieldHelp text="Enter the new password again to prevent an accidental typo before it replaces the current password." /></span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required /></label>
        <button className="button button-primary" disabled={changePassword.isPending}>{changePassword.isPending ? "Updating..." : "Update password"}</button>
      </form>
    </section>
    <section className="settings-section danger-section"><div><h2>Current session</h2><span>Signed in as {user.username}</span></div><button className="button button-danger" onClick={() => void logout()}><LogOut size={16} />Sign out</button></section>
  </div>;
}
