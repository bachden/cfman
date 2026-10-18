export type User = {
  id: string;
  username: string;
  mustChangePassword: boolean;
};

export type ExecutionVariables = Record<string, string>;

// Tunnel identity values the server injects into every execution. A script that
// declares an argument under one of these names replaces it for that run, so
// the UI warns wherever an operator can create that collision.
export const TUNNEL_BUILT_IN_VARIABLES = ["TENANT_CODE", "TUNNEL_NAME", "TUNNEL_CODE"];

export type ScriptArgument = {
  name: string;
  defaultValue: string;
  description: string;
  required: boolean;
};

// How a declared script argument gets its value at execution time, chosen by
// the operator when preparing a run. This mapping only exists at that moment -
// it is never persisted as part of the script/argument definition, and script
// arguments and environment variables otherwise know nothing about each other.
export type ArgumentBinding =
  | { type: "custom"; value: string }
  | { type: "variable"; variable: string };

export type ArgumentBindings = Record<string, ArgumentBinding>;

// Where a resolved argument value came from, recorded at execution time so
// history can show it later even though the binding itself is never
// persisted as part of the script/argument definition.
export type ArgumentValueSource =
  | { origin: "custom" }
  | { origin: "default" }
  | { origin: "variable"; variable: string; scope: "global" | "account" | "zone" | "tunnel" | "built-in" | "computer" };

export type BrandIcon = "cloud-cog" | "cloud" | "cable" | "globe" | "shield-check" | "server" | "zap";

export type Branding = {
  icon: BrandIcon;
  title: string;
  subtitle: string;
};

export type AppSettings = {
  publicBaseUrl: string;
  configured: boolean;
  executionVariables: ExecutionVariables;
  branding: Branding;
  mcp: {
    enabled: boolean;
    endpoint: string;
    tokenHint: string | null;
    rotatedAt: string | null;
    lastUsedAt: string | null;
  };
};

export type Zone = {
  id: string;
  name: string;
  cfZoneId: string | null;
  status: string;
  dnsRecordLimit: number;
  softTunnelLimit: number;
  tunnelCount: number;
  executionVariables: ExecutionVariables;
};

export type CloudflareAccount = {
  id: string;
  name: string;
  providerMode: "live" | "mock";
  cfAccountId: string | null;
  status: string;
  tunnelLimit: number;
  softTunnelLimit: number;
  rdpAllowedEmails: string[];
  tunnelCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  zones: Zone[];
  executionVariables: ExecutionVariables;
};

export type TunnelRoute = {
  id: string;
  path: string;
  serviceUrl: string;
  kind: "service" | "command_agent";
  wafEnabled: boolean;
  wafAllowedIps: string[];
  wafRulesetId: string | null;
  wafRuleId: string | null;
};

export type TunnelPublication = {
  id: string;
  suffix: string;
  customLabel: string | null;
  hostname: string;
  status: string;
  lastError: string | null;
  routes: TunnelRoute[];
};

export type Tunnel = {
  id: string;
  tenantCode: string;
  tunnelCode: string;
  displayName: string;
  originUrl: string;
  hostname: string;
  cfTunnelId: string | null;
  cfTunnelName: string | null;
  cfTunnelStatus: string;
  onboardingStatus: string;
  latestEnrollmentStatus?: string | null;
  hasPendingActivity?: boolean;
  activeEnrollmentPlatform?: "windows" | "unix" | null;
  accountId: string;
  cfAccountId: string | null;
  accountName: string;
  zoneId: string;
  zoneName: string;
  lastConnectedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  wafWarning: string | null;
  createdAt: string;
  rdpStatus: string;
  rdpTargetIp: string | null;
  rdpUrl: string | null;
  rdpLastError: string | null;
  sshStatus: string;
  sshTargetIp: string | null;
  sshPort: number;
  sshUsername: string | null;
  sshUrl: string | null;
  sshLastError: string | null;
  publications: TunnelPublication[];
  executionVariables: ExecutionVariables;
  enrollments?: TunnelEnrollment[];
  commandExecutions?: TunnelCommandExecution[];
  commandAgent?: {
    enabled: boolean;
    hostname: string;
    path: string;
    endpoint: string;
    status: "pending" | "ready" | "failed";
    lastSeenAt: string | null;
    lastError: string | null;
  } | null;
};

export type TunnelDeleteCheck = {
  id: "tunnel" | "enrollments" | "commands" | "cloudflare";
  label: string;
  ok: boolean;
  detail: string;
  resolution: string;
};

export type TunnelDeletePreflight = {
  tunnelId: string;
  displayName: string;
  canDelete: boolean;
  checks: TunnelDeleteCheck[];
  checkedAt: string;
};

export type TunnelEnrollment = {
  id: string;
  computerName: string | null;
  isCurrent: boolean;
  deletedAt: string | null;
  status: string;
  platform: "windows" | "unix" | null;
  environment: "windows" | "linux" | "darwin" | "unix" | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  installedAt: string | null;
  lastError: string | null;
  unenrollStatus: "not_required" | "pending" | "unenrolled" | "failed";
  unenrollReason: "script" | "override" | null;
  unenrollRequestedAt: string | null;
  unenrollTokenExpiresAt: string | null;
  unenrollLastError: string | null;
  unenrolledAt: string | null;
  logCount: number;
  executionVariables: ExecutionVariables;
  hostInfo: {
    osName?: string;
    osVersion?: string;
    osBuild?: string;
    architecture?: string;
    machineName?: string;
  };
  scripts: Array<{
    kind: "install" | "unenroll";
    platform: "windows" | "unix";
    status: "available" | "running" | "completed" | "failed" | "staled_ignored";
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string | null;
  }>;
};

export type TunnelCommandExecution = {
  id: string;
  enrollmentId: string | null;
  scriptType: "managed" | "inline";
  scriptId: string | null;
  scriptVersionId: string | null;
  savedScriptId: string | null;
  savedScriptVersionId: string | null;
  savedAt: string | null;
  scriptName: string | null;
  scriptVersion: number | null;
  platform: "windows" | "unix" | null;
  language: "powershell" | "bash" | "sh" | null;
  script: string;
  timeoutMs: number;
  status: "scheduled" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "never_run";
  taskId: string | null;
  processId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  requestedBy: string | null;
  requestedVia: "web" | "mcp" | "automation";
  // Set when a rule script dispatched this execution.
  automationRunId?: string | null;
  bulkExecutionId?: string | null;
  environmentVariables: ExecutionVariables;
  argumentSources: Record<string, ArgumentValueSource>;
  // The arguments actually declared for this run - from the script version
  // for a managed script, or the ad hoc list an operator typed in when
  // preparing an inline run - independent of environmentVariables/
  // argumentSources, which also carry the tunnel identity built-ins every
  // execution receives whether or not any argument was declared for them.
  scriptArguments: ScriptArgument[] | null;
};

export type ScriptCommandExecution = TunnelCommandExecution & {
  tunnelId: string;
  tunnelDisplayName: string;
  tenantCode: string;
  tunnelCode: string;
  computerName: string | null;
  osName: string | null;
  environment: "windows" | "linux" | "darwin" | "unix" | null;
  enrollmentPlatform: "windows" | "unix" | null;
  anchorScriptVersionId: string;
};

export type ManagedScriptSummary = {
  id: string;
  name: string;
  platform: "windows" | "unix";
  language: "powershell" | "bash" | "sh";
  description: string;
  defaultTimeoutMs: number;
  latestVersion: number | null;
  latestVersionId: string | null;
  versionCount: number;
  executionStats: ExecutionStats;
  updatedAt: string;
  createdAt: string;
};

export type ExecutionStats = {
  total: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  scheduled: number;
  running: number;
};

export const emptyExecutionStats: ExecutionStats = {
  total: 0,
  succeeded: 0,
  failed: 0,
  timedOut: 0,
  cancelled: 0,
  scheduled: 0,
  running: 0
};

export type ManagedScript = ManagedScriptSummary & {
  versions: Array<{
    id: string;
    version: number;
    content: string;
    // Argument definitions are pinned to the version, not the script: an
    // immutable version keeps the arguments its runs were prepared against.
    arguments: ScriptArgument[];
    createdAt: string;
    createdBy: string | null;
  }>;
};

export type BulkScriptRun = {
  id: string;
  name: string;
  description: string;
  scriptVersionId: string;
  timeoutMs: number;
  createdAt: string;
  requestedBy: string | null;
  requestedVia: "web" | "mcp" | "automation";
  selectedCount: number;
  running: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  scheduled: number;
  argumentBindings: ArgumentBindings;
};

export type EnrollmentResult = {
  id: string;
  expiresAt: string;
  urls: {
    shell: string;
    powershell: string;
  };
};

export type UnenrollmentResult = {
  tunnelId: string;
  enrollmentId: string;
  createdAt: string;
  expiresAt: string;
  urls: {
    shell: string;
    powershell: string;
  };
  automatic?: {
    requested: boolean;
    status: "scheduled" | "failed" | "unavailable";
    executionId: string | null;
    platform: "windows" | "unix" | null;
    error: string | null;
  };
};

export type DiagnoseResult = {
  enrollmentId: string;
  diagnosticRunId: string;
  status: "pending";
  platform: "windows" | "unix";
  expiresAt: string;
  urls: {
    shell: string;
    powershell: string;
  };
};

export type NotificationChannelType = "telegram";

export type NotificationChannel = {
  id: string;
  key: string;
  name: string;
  type: NotificationChannelType;
  typeLabel: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  // Never the secret itself - only the last characters of what is stored.
  secretHints: Record<string, string>;
  target: string;
  // Whether a rule script can ask a question with buttons on this channel.
  supportsButtons: boolean;
  maxButtons: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationMessage = {
  id: string;
  body: string;
  status: "sent" | "failed";
  error: string | null;
  providerMessageId: string | null;
  automationRunId: string | null;
  ruleKey: string | null;
  ruleName: string | null;
  requestedVia: "web" | "mcp" | "automation";
  requestedBy: string | null;
  createdAt: string;
};

export type AutomationRuleVersion = {
  id: string;
  version: number;
  scriptSource: string;
  createdAt: string;
  createdBy: string | null;
};

export type AutomationRule = {
  id: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: { cron: string; timezone: string };
  scriptTimeoutMs: number;
  // The newest version is the script the rule runs; the full list comes with
  // the single-rule read only.
  latestVersionId: string | null;
  latestVersion: number | null;
  versionCount: number;
  versions?: AutomationRuleVersion[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: AutomationRunStatus | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
};

export type AutomationRunStatus = "running" | "succeeded" | "failed" | "timed_out";

export type AutomationRunLog = { at: string; level: "log" | "warn" | "error"; message: string };

export type AutomationRunExecution = {
  id: string;
  tunnelId: string;
  tunnelDisplayName: string;
  tenantCode: string;
  tunnelCode: string;
  scriptName: string;
  scriptId: string | null;
  scriptVersion: number | null;
  status: string;
  exitCode: number | null;
  elapsedMs: number | null;
  createdAt: string;
};

export type AutomationRunPrompt = {
  id: string;
  channelKey: string;
  body: string;
  buttons: Array<{ label: string; value: string }>;
  status: "pending" | "answered" | "timed_out" | "failed";
  answerLabel: string | null;
  answerValue: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  error: string | null;
  createdAt: string;
};

export type AutomationRun = {
  id: string;
  ruleId: string;
  // Counts up per rule across every version of its script; how a run is
  // referred to, including by cfman.getRun(ruleKey, sequence).
  sequence: number;
  ruleKey?: string;
  ruleName?: string;
  trigger: "timer" | "manual" | "mcp";
  status: AutomationRunStatus;
  triggerPayload: Record<string, unknown>;
  scriptVersionId: string | null;
  scriptVersion: number | null;
  outputBody: string;
  outputMimeType: string | null;
  outputTruncated: boolean;
  logs: AutomationRunLog[];
  // Questions this run asked in chat, with the button that was pressed.
  prompts: AutomationRunPrompt[];
  // Script executions this run dispatched on tunnels.
  executions: AutomationRunExecution[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  triggeredBy: string | null;
};

export type AutomationCapabilities = {
  context: Array<{ signature: string; description: string }>;
  defaultTimezone: string;
  // TypeScript declarations for the sandbox globals, fed to the Monaco
  // JavaScript language service so cfman. completes to the real calls.
  typeDefinitions: string;
};
