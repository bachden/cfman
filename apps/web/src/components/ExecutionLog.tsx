import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { STORE_BUILT_IN_VARIABLES, type ArgumentValueSource, type StoreCommandExecution } from "../types";
import { CopyButton } from "./CopyButton";

type ArgumentValueScope = Extract<ArgumentValueSource, { origin: "variable" }>["scope"];

const SCOPE_LABELS: Record<ArgumentValueScope, string> = {
  global: "Global",
  account: "Account",
  zone: "Zone",
  store: "Store",
  "built-in": "Built-in",
  computer: "Computer"
};

function formatArgumentSource(source: ArgumentValueSource | undefined): string {
  if (!source) return "—";
  if (source.origin === "custom") return "Custom";
  if (source.origin === "default") return "Default";
  return `Variable · ${SCOPE_LABELS[source.scope]}`;
}

type ExecutionLogResponse = {
  execution: Pick<StoreCommandExecution, "status" | "taskId" | "processId" | "stdout" | "stderr" | "error">;
  logs: Array<{ id: number; stream: "stdout" | "stderr"; line: string; createdAt: string }>;
  nextAfter: number;
};

type LogStreamFilter = "stdout" | "stderr" | "all";

export function ExecutionLog({ storeId, execution }: { storeId: string; execution: StoreCommandExecution }) {
  const queryClient = useQueryClient();
  const queryKey = ["execution-stream-logs", storeId, execution.id];
  const { data, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: () => api.get<ExecutionLogResponse>(`/api/stores/${storeId}/command-executions/${execution.id}/logs?after=0&limit=1000`),
    refetchInterval: (query) => ["scheduled", "running"].includes(query.state.data?.execution.status ?? execution.status) ? 1000 : false
  });
  const cancel = useMutation({
    mutationFn: () => api.post<{ executionId: string; taskId: string; status: "cancelled" }>(`/api/stores/${storeId}/command-executions/${execution.id}/cancel`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["command-executions", storeId] }),
        queryClient.invalidateQueries({ queryKey: ["script-executions"] }),
        queryClient.invalidateQueries({ queryKey: ["script-execution-history"] }),
        queryClient.invalidateQueries({ queryKey: ["bulk-script-execution-detail"] }),
        queryClient.invalidateQueries({ queryKey: ["bulk-script-executions"] }),
        queryClient.invalidateQueries({ queryKey })
      ]);
      toast.success("Execution cancelled");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to cancel execution")
  });
  const current = data?.execution ?? execution;
  const logs = data?.logs ?? [];
  const active = ["scheduled", "running"].includes(current.status);
  const [streamFilter, setStreamFilter] = useState<LogStreamFilter>("all");
  const filteredLogs = streamFilter === "all" ? logs : logs.filter((entry) => entry.stream === streamFilter);
  const selectedStdout = streamFilter !== "stderr" ? current.stdout : null;
  const selectedStderr = streamFilter !== "stdout" ? current.stderr : null;
  const copyValue = logs.length
    ? filteredLogs.map((entry) => streamFilter === "all" ? `[${entry.stream}] ${entry.line}` : entry.line).join("\n")
    : streamFilter === "all"
      ? [current.stdout && `[stdout]\n${current.stdout}`, current.stderr && `[stderr]\n${current.stderr}`].filter(Boolean).join("\n")
      : (streamFilter === "stdout" ? current.stdout : current.stderr) ?? "";
  const noOutputMessage = streamFilter === "all" ? "The script produced no output." : `The script produced no ${streamFilter} output.`;
  const appliedVariables = Object.entries(execution.environmentVariables ?? {}).sort(([left], [right]) => left.localeCompare(right));

  return <>
    {appliedVariables.length > 0 && <details className="execution-applied-variables"><summary>Applied arguments ({appliedVariables.length})</summary>
      <div className="execution-applied-variable-row execution-applied-variable-row-header" aria-hidden="true"><span>Name</span><span>Value</span><span>Source</span></div>
      <div className="execution-applied-variable-list">{appliedVariables.map(([name, value]) => {
        const source = execution.argumentSources?.[name];
        // The built-ins are injected under their own name from the built-in
        // scope. Anything else carrying a built-in name is a declared argument
        // that took the name over for this run, so the store identity value is
        // not what the script saw.
        const shadowsBuiltIn = STORE_BUILT_IN_VARIABLES.includes(name)
          && !(source?.origin === "variable" && source.variable === name && source.scope === "built-in");
        return <div className="execution-applied-variable-row" key={name}>
          <code className="execution-applied-variable-name mono">{name}{shadowsBuiltIn && <span className="script-argument-shadow-flag" title={`${name} is a built-in store identity variable, but this script declares an argument with the same name. The script received the mapped argument value below instead of the store's ${name}.`}>shadows built-in</span>}</code>
          <code className="execution-applied-variable-value mono">{value}</code>
          <span className="execution-applied-variable-source">{formatArgumentSource(source)}</span>
        </div>;
      })}</div>
    </details>}
    <div className="execution-log-actions">
      <span><code>{Math.round(execution.timeoutMs / 1000)}s timeout</code>{current.taskId ? <> · Task <code>{current.taskId}</code>{current.processId ? <> · PID <code>{current.processId}</code></> : null}</> : " · No task metadata reported yet"}</span>
      <div className="execution-log-filter" role="radiogroup" aria-label="Execution log stream">
        <span className="execution-log-filter-label">Filter</span>
        {(["stdout", "stderr", "all"] as const).map((stream) => <label key={stream}>
          <input type="radio" name={`execution-log-stream-${execution.id}`} value={stream} checked={streamFilter === stream} onChange={() => setStreamFilter(stream)} />
          {stream}
        </label>)}
      </div>
      {copyValue && <CopyButton value={copyValue} label="Copy visible log" iconOnly />}
      <button className="icon-button" type="button" title="Refresh execution log" aria-label="Refresh execution log" disabled={isFetching} onClick={() => void refetch()}><RefreshCw size={14} className={isFetching ? "spin-icon" : undefined} /></button>
      {active && <button className="button button-danger button-small" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}><Ban size={14} />{cancel.isPending ? "Cancelling..." : "Cancel execution"}</button>}
    </div>
    {current.error && <div className="inline-alert">{current.error}</div>}
    {logs.length ? filteredLogs.length ? <pre className="streaming-log">{filteredLogs.map((line) => <span className={`stream-line stream-line-${line.stream}`} key={line.id}><small>{line.stream}</small>{line.line}{"\n"}</span>)}</pre> : <div className="quiet-empty">No {streamFilter} output has been reported.</div> : <>
      {selectedStdout && <div className="command-output-block"><header><strong>stdout</strong></header><pre>{selectedStdout}</pre></div>}
      {selectedStderr && <div className="command-output-block"><header><strong>stderr</strong></header><pre>{selectedStderr}</pre></div>}
      {!selectedStdout && !selectedStderr && !current.error && <div className="quiet-empty">{active ? "Waiting for output..." : noOutputMessage}</div>}
    </>}
  </>;
}
