import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FilePlus2, RefreshCw, Save, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { useDrawers } from "../components/DrawerContext";
import { ExecutionStatsSummary } from "../components/ExecutionStatsSummary";
import { FieldHelp } from "../components/FieldHelp";
import { HostPlatformIcon } from "../components/HostPlatformIcon";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { ScriptEditor } from "../components/ScriptEditor";
import { SearchableSelect } from "../components/SearchableSelect";
import type { ManagedScriptSummary } from "../types";

const defaultContent = {
  windows: "Write-Output \"Store: $env:COMPUTERNAME\"\n",
  unix: "printf 'Store: %s\\n' \"$(hostname)\"\n"
};

const platformFilterOptions = [
  { value: "", label: "All platforms" },
  { value: "windows", label: "Windows" },
  { value: "unix", label: "Unix" }
];

type ScriptListPage = {
  scripts: ManagedScriptSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export function ScriptsPage() {
  const queryClient = useQueryClient();
  const { openScriptDrawer } = useDrawers();
  const [searchParams, setSearchParams] = useSearchParams();
  const [nameFilter, setNameFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState<"" | "windows" | "unix">("");
  const [scriptPage, setScriptPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPlatform, setCreatePlatform] = useState<"windows" | "unix">("windows");
  const [createLanguage, setCreateLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [createDescription, setCreateDescription] = useState("");
  const [createTimeoutSeconds, setCreateTimeoutSeconds] = useState(60);
  const [createContent, setCreateContent] = useState(defaultContent.windows);
  const scriptPageSize = 12;
  const scriptParams = new URLSearchParams({ page: String(scriptPage), pageSize: String(scriptPageSize) });
  if (nameFilter.trim()) scriptParams.set("name", nameFilter.trim());
  if (platformFilter) scriptParams.set("platform", platformFilter);
  const { data, isLoading } = useQuery({
    queryKey: ["scripts", nameFilter, platformFilter, scriptPage, scriptPageSize],
    queryFn: () => api.get<ScriptListPage>(`/api/scripts?${scriptParams.toString()}`)
  });
  const scripts = data?.scripts ?? [];
  const scriptPagination = data?.pagination;

  useEffect(() => setScriptPage(1), [nameFilter, platformFilter]);

  useEffect(() => {
    const linkedScriptId = searchParams.get("scriptId");
    if (!linkedScriptId) return;
    const linkedVersion = Number(searchParams.get("version"));
    openScriptDrawer(linkedScriptId, Number.isInteger(linkedVersion) ? linkedVersion : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openScript = (script: ManagedScriptSummary) => {
    openScriptDrawer(script.id);
    setSearchParams({ scriptId: script.id }, { replace: true });
  };

  const openCreate = () => {
    setCreateName("");
    setCreatePlatform("windows");
    setCreateLanguage("powershell");
    setCreateDescription("");
    setCreateTimeoutSeconds(60);
    setCreateContent(defaultContent.windows);
    setCreateOpen(true);
  };
  const changeCreatePlatform = (platform: "windows" | "unix") => {
    setCreatePlatform(platform);
    setCreateLanguage(platform === "windows" ? "powershell" : "bash");
    setCreateContent(defaultContent[platform]);
  };
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/api/scripts", { name: createName, platform: createPlatform, language: createLanguage, description: createDescription, defaultTimeoutMs: createTimeoutSeconds * 1000, content: createContent }),
    onSuccess: async (result) => {
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["scripts"] });
      toast.success("Script created");
      openScriptDrawer(result.id);
      setSearchParams({ scriptId: result.id }, { replace: true });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to create script")
  });
  const refresh = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: ["scripts"], type: "active" }),
    onSuccess: () => toast.success("Script library refreshed"),
    onError: () => toast.error("Unable to refresh script library")
  });

  return <div className="page">
    <PageHeader title="Script library" eyebrow="Versioned store automation" actions={<><button className="button button-secondary" type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={15} className={refresh.isPending ? "spin-icon" : undefined} />{refresh.isPending ? "Refreshing..." : "Refresh"}</button><button className="button button-primary" type="button" onClick={openCreate}><FilePlus2 size={16} />New script</button></>} />
    <div className="toolbar">
      <label className="search-box"><Search size={15} /><input value={nameFilter} onChange={(event) => setNameFilter(event.target.value)} placeholder="Search script names" /></label>
      <div className="script-platform-filter"><SearchableSelect name="platformFilter" options={platformFilterOptions} ariaLabel="Filter scripts by platform" emptyMessage="No matching platforms" onValueChange={(value) => setPlatformFilter(value as typeof platformFilter)} /></div>
    </div>
    <section className="panel table-panel script-table-panel">
      <div className="table-scroll"><table><thead><tr><th>Script</th><th>Language</th><th>Versions</th><th>Executions</th></tr></thead><tbody>
        {isLoading ? <tr><td colSpan={4}><div className="quiet-empty">Loading scripts...</div></td></tr> : scripts.length === 0 ? <tr><td colSpan={4}><div className="quiet-empty">No scripts saved yet.</div></td></tr> : scripts.map((script) => (
          <tr key={script.id} className="data-row" onClick={() => openScript(script)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openScript(script); } }} tabIndex={0}>
            <td><div className="primary-cell"><strong className="script-name-cell"><HostPlatformIcon platform={script.platform} size={15} />{script.name}</strong><span>{script.description || "No description"}</span></div></td>
            <td>{script.language}</td>
            <td>{script.versionCount} version{script.versionCount === 1 ? "" : "s"}</td>
            <td><ExecutionStatsSummary stats={script.executionStats} /></td>
          </tr>
        ))}
      </tbody></table></div>
      {scriptPagination && scriptPagination.total > 0 && <div className="table-pagination"><span>{scriptPagination.total} total</span><div><button className="icon-button" type="button" title="Previous script page" aria-label="Previous script page" disabled={scriptPagination.page <= 1} onClick={() => setScriptPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span>Page {scriptPagination.page} of {scriptPagination.totalPages}</span><button className="icon-button" type="button" title="Next script page" aria-label="Next script page" disabled={scriptPagination.page >= scriptPagination.totalPages} onClick={() => setScriptPage((page) => page + 1)}><ChevronRight size={15} /></button></div></div>}
    </section>
    <Modal open={createOpen} title="Create new script" onClose={() => setCreateOpen(false)} width="wide">
      <div className="command-quick-create">
        <div className="script-metadata-grid command-quick-create-fields">
          <label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown when an operator selects a script for a store. Names must be unique within the same platform." /></span><input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="Inventory refresh" /></label>
          <label className="field"><span className="field-label">Platform <FieldHelp text="The host family this script can run on. Windows scripts use PowerShell; Unix scripts can use Bash or POSIX sh. The platform cannot change after creation." /></span><select value={createPlatform} onChange={(event) => changeCreatePlatform(event.target.value as "windows" | "unix")}><option value="windows">Windows</option><option value="unix">Unix</option></select></label>
          <label className="field"><span className="field-label">Language</span><select value={createLanguage} onChange={(event) => setCreateLanguage(event.target.value as typeof createLanguage)}>{createPlatform === "windows" ? <option value="powershell">PowerShell</option> : <><option value="bash">Bash</option><option value="sh">POSIX sh</option></>}</select></label>
          <label className="field"><span className="field-label">Description</span><input value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="Optional description" /></label>
          <label className="field"><span className="field-label">Default timeout (seconds)</span><input type="number" min={1} max={300} value={createTimeoutSeconds} onChange={(event) => setCreateTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label>
        </div>
        <ScriptEditor value={createContent} language={createLanguage} height="300px" onChange={setCreateContent} />
        <div className="form-actions"><span className="script-editor-hint">Creates version 1</span><button className="button button-primary" type="button" disabled={!createName.trim() || !createContent.trim() || create.isPending} onClick={() => create.mutate()}><Save size={15} />{create.isPending ? "Saving..." : "Create script"}</button></div>
      </div>
    </Modal>
  </div>;
}
