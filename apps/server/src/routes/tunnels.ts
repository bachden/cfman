import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { getPublicBaseUrl } from "../lib/app-settings.js";
import { requireAuth } from "../lib/auth.js";
import { CloudflareClient } from "../lib/cloudflare.js";
import { pool, withTransaction } from "../lib/database.js";
import { appendNameFilter, nameFilterFields, validateNameFilter } from "../lib/name-filter.js";
import { decryptSecret, encryptSecret } from "../lib/security.js";
import { reconfigureTunnel } from "../lib/provisioning.js";
import { CFMAN_REMOTE_AGENT_WAF_WARNING, cloudflareManPublicHostname, defaultWafAllowedIps, ensureCloudflareManRemoteAgentRoutes, isCfmanRemoteAgentPath, isCloudflareManPublicHostname, isValidIpOrCidr, reconcileZoneWaf, resolveWafAllowedIps } from "../lib/route-waf.js";
import { completeRdpEnableExecution, provisionBrowserRdp, rdpEnableScript, RDP_ENABLE_SCRIPT_MARKER } from "../lib/rdp.js";
import { provisionBrowserSsh, syncBrowserSsh } from "../lib/ssh.js";
import { verifyTunnelEndpoints } from "../lib/tunnel-verification.js";
import { synchronizeAccount } from "./accounts.js";
import { createOpaqueToken, hashToken } from "../lib/security.js";
import { selectZone, slugifyLabel } from "../lib/tunnels.js";
import { automaticUnenrollmentScript, cancelCommandExecution, createCommandExecution, executeTunnelScript, getCommandAgentConfig, ensureCommandAgentToken, COMMAND_AGENT_SERVICE_URL } from "../lib/command-agent.js";
import { argumentBindingsSchema, applyScriptArguments, describeArgumentValueSources, executionVariablesSchema, resolveArgumentValues, resolveAvailableVariablesForTunnel, scriptArgumentsSchema, type ExecutionVariables, type ScriptArgument } from "../lib/execution-variables.js";

const serviceUrlSchema = z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://") || value.startsWith("ssh://"), {
  message: "Service URL must use HTTP, HTTPS, or SSH"
});
const optionalServiceUrlSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  serviceUrlSchema.optional()
);

const routeKindSchema = z.enum(["service", "command_agent"]);
const routeSchema = z.object({
  kind: routeKindSchema.default("service"),
  path: z.string().trim().min(1).max(200).regex(/^\//, "Path must start with /"),
  serviceUrl: optionalServiceUrlSchema
}).superRefine((route, context) => {
  if (route.kind === "service" && !route.serviceUrl) {
    context.addIssue({ code: "custom", path: ["serviceUrl"], message: "A service URL is required" });
  }
});

const publicationSchema = z.object({
  suffix: z.string().trim().max(30).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,28}[a-zA-Z0-9])?)?$/,
    "Suffix can contain letters, numbers, and inner hyphens"
  ).transform((value) => value.toLowerCase()),
  // When set, this is used verbatim as the full subdomain label instead of
  // the tunnel-id-derived `suffix` above - lets an operator publish a
  // hostname that has nothing to do with the tunnel id.
  customLabel: z.string().trim().min(1).max(63).regex(
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/,
    "Subdomain can contain letters, numbers, and inner hyphens"
  ).transform((value) => value.toLowerCase()).optional(),
  routes: z.array(routeSchema).min(1).max(20)
});

const publicationsSchema = z.array(publicationSchema).min(1).max(20).superRefine((publications, context) => {
  let commandAgentRoutes = 0;
  let sshRoutes = 0;
  const labelKeys = new Set<string>();
  publications.forEach((publication, publicationIndex) => {
    const labelKey = publication.customLabel ? `custom:${publication.customLabel}` : `suffix:${publication.suffix}`;
    if (labelKeys.has(labelKey)) {
      context.addIssue({ code: "custom", path: [publicationIndex, publication.customLabel ? "customLabel" : "suffix"], message: "Each subdomain must be unique" });
    }
    labelKeys.add(labelKey);
    const paths = new Set<string>();
    publication.routes.forEach((route, routeIndex) => {
      if (route.kind === "command_agent") commandAgentRoutes += 1;
      if (route.kind === "service" && route.serviceUrl?.startsWith("ssh://")) sshRoutes += 1;
      if (paths.has(route.path)) {
        context.addIssue({ code: "custom", path: [publicationIndex, "routes", routeIndex, "path"], message: "Each path must be unique within its subdomain" });
      }
      paths.add(route.path);
    });
  });
  if (commandAgentRoutes > 1) {
    context.addIssue({ code: "custom", message: "Only one command agent route can be configured per tunnel" });
  }
  if (sshRoutes > 1) {
    context.addIssue({ code: "custom", message: "Only one ssh:// route can be configured per tunnel" });
  }
});

const createTunnelSchema = z.object({
  tenantCode: z.string().trim().min(1).max(80),
  tunnelCode: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(2).max(160),
  originUrl: serviceUrlSchema.optional(),
  zoneId: z.string().uuid().optional(),
  publications: publicationsSchema.optional()
}).superRefine((data, context) => {
  if (!data.publications && !data.originUrl) {
    context.addIssue({ code: "custom", path: ["originUrl"], message: "An origin URL or publication routes are required" });
  }
});

const connectivitySchema = z.object({ publications: publicationsSchema });

const CIDR_MAX_LENGTH = 64;
const routeWafSchema = z.object({
  enabled: z.boolean().default(true),
  allowedIps: z.array(z.string().trim().min(1).max(CIDR_MAX_LENGTH)).max(20).default([])
});

const listQuerySchema = z.object({
  ...nameFilterFields,
  search: z.string().trim().max(120).optional(),
  tenantCode: z.string().trim().max(80).optional(),
  status: z.string().trim().max(40).optional(),
  cfTunnelStatus: z.string().trim().max(40).optional(),
  enrollmentStatus: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25)
}).superRefine(validateNameFilter);

const refreshTunnelsSchema = z.object({
  tunnelIds: z.array(z.string().uuid()).min(1).max(100)
});

const commandExecutionListSchema = z.object({
  search: z.string().trim().max(120).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/, "Timestamp must use ISO 8601 format").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/, "Timestamp must use ISO 8601 format").optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10)
});
const enrollmentListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10)
});
const commandExecutionLogListSchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
});

const enrollmentSchema = z.object({
  expiresInHours: z.number().int().min(1).max(168).default(24)
});

const unenrollmentRequestSchema = enrollmentSchema.extend({
  automatic: z.boolean().default(false)
});

const executeScriptSchema = z.object({
  scriptVersionId: z.string().uuid().optional(),
  inlineScript: z.string().min(1).max(262_144).refine((value) => value.trim().length > 0, "Inline script content is required").optional(),
  name: z.string().trim().min(1).max(120).optional(),
  language: z.enum(["powershell", "bash", "sh"]).optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  // A saved script's arguments are declared on its immutable version, not
  // chosen per run - only an inline script, which has no version to declare
  // them on, accepts an ad hoc list here.
  arguments: scriptArgumentsSchema.optional(),
  argumentBindings: argumentBindingsSchema.default({})
}).superRefine((data, context) => {
  if (Boolean(data.scriptVersionId) === Boolean(data.inlineScript)) {
    context.addIssue({ code: "custom", message: "Provide exactly one saved script version or inline script" });
  }
  if (data.scriptVersionId && (data.language || data.name || data.arguments)) {
    context.addIssue({ code: "custom", message: "Name, language, and arguments are only accepted for inline scripts" });
  }
});

const resolveExecutionVariablesSchema = z.object({
  scriptVersionId: z.string().uuid().optional()
});

const saveInlineExecutionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional()
});

const deleteTunnelSchema = z.object({
  confirmName: z.string().trim().max(160).optional(),
  force: z.boolean().default(false)
});

type TunnelDeleteExecutor = Pick<PoolClient, "query">;
type TunnelDeleteContext = {
  id: string;
  displayName: string;
  tunnelCode: string;
  cfTunnelId: string | null;
  cfTunnelStatus: string;
  rdpRouteId: string | null;
  rdpTargetId: string | null;
  rdpVnetId: string | null;
  providerMode: "live" | "mock";
  accountRowId: string;
  cfAccountId: string | null;
  apiTokenEncrypted: string | null;
  zoneId: string;
  cfZoneId: string | null;
  activeEnrollmentCount: number;
  activeEnrollmentPlatforms: string | null;
  runningCommandCount: number;
  commandAgentStatus: string | null;
  commandAgentLastSeenAt: string | null;
  publications: Array<{
    hostname: string;
    dnsRecordId: string | null;
    path: string;
    wafRulesetId: string | null;
    wafRuleId: string | null;
  }>;
};

type TunnelDeleteCheck = {
  id: "tunnel" | "enrollments" | "commands" | "cloudflare";
  label: string;
  ok: boolean;
  detail: string;
  resolution: string;
};

type TunnelDeletePreflight = {
  tunnelId: string;
  displayName: string;
  canDelete: boolean;
  checks: TunnelDeleteCheck[];
  checkedAt: string;
};

async function enrollmentUrls(token: string) {
  const publicBaseUrl = await getPublicBaseUrl();
  return {
    shell: `${publicBaseUrl}/e/${token}/install.sh`,
    powershell: `${publicBaseUrl}/e/${token}/install.ps1`
  };
}

async function unenrollmentUrls(token: string) {
  const publicBaseUrl = await getPublicBaseUrl();
  return {
    shell: `${publicBaseUrl}/e/${token}/unenroll.sh`,
    powershell: `${publicBaseUrl}/e/${token}/unenroll.ps1`
  };
}

async function loadTunnelDeleteContext(executor: TunnelDeleteExecutor, tunnelId: string): Promise<TunnelDeleteContext | null> {
  const tunnelResult = await executor.query(
    `SELECT s.id, s.display_name AS "displayName", s.tunnel_code AS "tunnelCode",
            s.cf_tunnel_id AS "cfTunnelId", s.cf_tunnel_status AS "cfTunnelStatus",
            s.rdp_route_id AS "rdpRouteId", s.rdp_target_id AS "rdpTargetId", s.rdp_vnet_id AS "rdpVnetId",
            s.zone_id AS "zoneId",
            a.id AS "accountRowId", a.provider_mode AS "providerMode", a.cf_account_id AS "cfAccountId",
            a.api_token_encrypted AS "apiTokenEncrypted", z.cf_zone_id AS "cfZoneId",
            (SELECT count(*)::int FROM enrollments e
              WHERE e.tunnel_id = s.id
                AND e.status IN ('claimed', 'provisioning', 'ready', 'installed')
                AND e.unenrolled_at IS NULL
                AND e.deleted_at IS NULL) AS "activeEnrollmentCount",
            (SELECT string_agg(COALESCE(e.platform, 'unknown'), ', ' ORDER BY e.created_at)
               FROM enrollments e
              WHERE e.tunnel_id = s.id
                AND e.status IN ('claimed', 'provisioning', 'ready', 'installed')
                AND e.unenrolled_at IS NULL
                AND e.deleted_at IS NULL) AS "activeEnrollmentPlatforms",
            (SELECT count(*)::int FROM tunnel_command_executions ce
              WHERE ce.tunnel_id = s.id AND ce.status IN ('scheduled', 'running')) AS "runningCommandCount",
            ca.status AS "commandAgentStatus", ca.last_seen_at AS "commandAgentLastSeenAt"
       FROM tunnels s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
       LEFT JOIN tunnel_command_agents ca ON ca.tunnel_id = s.id
      WHERE s.id = $1`,
    [tunnelId]
  );
  if (!tunnelResult.rowCount) return null;
  const publicationResult = await executor.query(
    `SELECT p.hostname, p.dns_record_id AS "dnsRecordId", r.path,
            r.waf_ruleset_id AS "wafRulesetId", r.waf_rule_id AS "wafRuleId"
       FROM tunnel_publications p
       JOIN tunnel_routes r ON r.publication_id = p.id
      WHERE p.tunnel_id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at`,
    [tunnelId]
  );
  return { ...tunnelResult.rows[0], publications: publicationResult.rows } as TunnelDeleteContext;
}

function buildTunnelDeletePreflight(context: TunnelDeleteContext): TunnelDeletePreflight {
  const activeTunnel = Boolean(context.cfTunnelId && ["healthy", "degraded", "connector_online"].includes(context.cfTunnelStatus));
  const tunnelCheck: TunnelDeleteCheck = {
    id: "tunnel",
    label: "Tunnel is disconnected",
    ok: !activeTunnel,
    detail: context.cfTunnelId ? `Tunnel ${context.cfTunnelId} is ${context.cfTunnelStatus}.` : "No Cloudflare Tunnel has been provisioned.",
    resolution: activeTunnel
      ? "Run the generated unenrollment command on the tunnel, stop cloudflared if needed, then refresh this check. Force delete will terminate Cloudflare tunnel connections."
      : "No action required."
  };
  const enrollmentCheck: TunnelDeleteCheck = {
    id: "enrollments",
    label: "All installed enrollments are unenrolled",
    ok: context.activeEnrollmentCount === 0,
    detail: context.activeEnrollmentCount
      ? `${context.activeEnrollmentCount} active enrollment${context.activeEnrollmentCount === 1 ? "" : "s"}${context.activeEnrollmentPlatforms ? ` (${context.activeEnrollmentPlatforms})` : ""}.`
      : "No active installed enrollment remains.",
    resolution: context.activeEnrollmentCount
      ? "Open Enrollment history, run the matching Windows or Unix unenrollment command, and wait for the status to become unenrolled."
      : "No action required."
  };
  const commandsCheck: TunnelDeleteCheck = {
    id: "commands",
    label: "No command execution is running",
    ok: context.runningCommandCount === 0,
    detail: context.runningCommandCount
      ? `${context.runningCommandCount} command execution${context.runningCommandCount === 1 ? " is" : "s are"} still running.`
      : "No command execution is currently running.",
    resolution: context.runningCommandCount
      ? "Wait for the command to finish or fail. Force delete removes the local execution history and may interrupt the remote request."
      : "No action required."
  };
  const cloudflareReady = context.providerMode === "mock" || Boolean(context.cfAccountId && context.cfZoneId && context.apiTokenEncrypted);
  const cloudflareCheck: TunnelDeleteCheck = {
    id: "cloudflare",
    label: "Cloudflare cleanup credentials are available",
    ok: cloudflareReady,
    detail: cloudflareReady ? `Tunnel-owned DNS and tunnel resources can be cleaned from the ${context.providerMode} account.` : "The live account or zone is missing its API credentials.",
    resolution: cloudflareReady
      ? "No action required."
      : "Open Account pool and restore the account token and zone ID before deleting, otherwise Cloudflare resources could be orphaned."
  };
  const checks = [tunnelCheck, enrollmentCheck, commandsCheck, cloudflareCheck];
  return {
    tunnelId: context.id,
    displayName: context.displayName,
    canDelete: checks.every((check) => check.ok),
    checks,
    checkedAt: new Date().toISOString()
  };
}

async function cleanupTunnelResources(context: TunnelDeleteContext): Promise<void> {
  const client = new CloudflareClient(
    context.cfAccountId ?? context.accountRowId,
    context.apiTokenEncrypted ? decryptSecret(context.apiTokenEncrypted) : "mock",
    context.providerMode
  );
  if (context.publications.some((publication) => publication.wafRuleId)) {
    // Excludes this tunnel's own routes so the zone's merged WAF rule is
    // rebuilt without them, instead of disabling each route individually.
    await reconcileZoneWaf(client, context.zoneId, context.cfZoneId, context.providerMode, { excludeTunnelId: context.id });
  }
  const deletedDnsRecords = new Set<string>();
  for (const publication of context.publications) {
    if (publication.dnsRecordId && context.cfZoneId && !deletedDnsRecords.has(publication.dnsRecordId)) {
      await client.deleteDnsRecord(context.cfZoneId, publication.dnsRecordId);
      deletedDnsRecords.add(publication.dnsRecordId);
    }
  }
  if (context.rdpRouteId) await client.deleteTunnelRoute(context.rdpRouteId);
  if (context.rdpTargetId) await client.deleteInfrastructureTarget(context.rdpTargetId);
  if (context.rdpVnetId) await client.deleteVirtualNetwork(context.rdpVnetId);
  if (context.cfTunnelId) {
    await client.deleteTunnelConnections(context.cfTunnelId);
    await client.deleteTunnel(context.cfTunnelId);
  }
}

const publicationsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', p.id,
    'suffix', p.suffix,
    'customLabel', p.custom_label,
    'hostname', p.hostname,
    'status', p.status,
    'lastError', p.last_error,
    'routes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id,
        'path', r.path,
        'serviceUrl', r.service_url,
        'kind', r.route_kind,
        'wafEnabled', r.waf_enabled,
        'wafAllowedIps', r.waf_allowed_ips,
        'wafRulesetId', r.waf_ruleset_id,
        'wafRuleId', r.waf_rule_id
      ) ORDER BY r.sort_order, r.created_at)
      FROM tunnel_routes r WHERE r.publication_id = p.id
    ), '[]'::jsonb)
  ) ORDER BY p.created_at)
  FROM tunnel_publications p WHERE p.tunnel_id = s.id
), '[]'::jsonb)`;

// A revoked/expired link that was never claimed is a dead end - if an older
// enrollment is still active (or otherwise live), prefer it so a tunnel
// doesn't display "revoked" while it's actually still enrolled.
export const latestEnrollmentJoin = `LEFT JOIN LATERAL (
  SELECT e.status, e.expires_at, e.unenrolled_at,
         EXISTS (
           SELECT 1
             FROM enrollments previous
            WHERE previous.tunnel_id = e.tunnel_id
              AND previous.id <> e.id
              AND previous.deleted_at IS NULL
              AND previous.unenrolled_at IS NULL
              AND previous.status IN ('claimed', 'provisioning', 'ready', 'installed')
         ) AS has_active_previous
    FROM enrollments e
   WHERE e.tunnel_id = s.id
     AND e.deleted_at IS NULL
   ORDER BY (e.status = 'revoked' OR e.status = 'expired' OR (e.status = 'url_issued' AND e.expires_at <= now())) ASC,
            e.created_at DESC, e.id DESC
   LIMIT 1
) latest_enrollment ON TRUE`;

// Kept in sync with the drawer's "isCurrent" concept (TunnelEnrollment.isCurrent,
// apps/web/src/components/TunnelDrawer.tsx): a ready/installed enrollment that
// hasn't been unenrolled is displayed as "active" everywhere, not the raw
// workflow status, so the tunnel list and the enrollment history never disagree.
export const onboardingStatusExpression = `CASE
  WHEN latest_enrollment.status IS NULL THEN s.onboarding_status
  WHEN latest_enrollment.status = 'url_issued' AND latest_enrollment.expires_at <= now() THEN 'expired'
  WHEN latest_enrollment.status = 'url_issued' AND latest_enrollment.has_active_previous THEN 'waiting_for_new_enrollment'
  WHEN latest_enrollment.status IN ('ready', 'installed') AND latest_enrollment.unenrolled_at IS NULL THEN 'active'
  ELSE latest_enrollment.status
END`;

const enrollmentsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
            'id', e.id,
    'computerName', NULLIF(e.host_info->>'machineName', ''),
    'isCurrent', e.deleted_at IS NULL
      AND e.unenrolled_at IS NULL
      AND e.status IN ('ready', 'installed')
      AND e.id = (
        SELECT current_enrollment.id
          FROM enrollments current_enrollment
         WHERE current_enrollment.tunnel_id = s.id
           AND current_enrollment.deleted_at IS NULL
           AND current_enrollment.unenrolled_at IS NULL
           AND current_enrollment.status IN ('ready', 'installed')
         ORDER BY COALESCE(current_enrollment.installed_at, current_enrollment.claimed_at, current_enrollment.created_at) DESC
         LIMIT 1
      ),
    'deletedAt', e.deleted_at,
    'status', e.status,
    'platform', CASE WHEN e.platform = 'windows' THEN 'windows' WHEN e.platform IS NOT NULL THEN 'unix' ELSE null END,
    'environment', e.platform,
    'createdAt', e.created_at,
    'expiresAt', e.expires_at,
    'claimedAt', e.claimed_at,
    'installedAt', e.installed_at,
    'lastError', e.last_error,
    'hostInfo', e.host_info,
    'executionVariables', e.execution_variables,
    'unenrollStatus', CASE
      WHEN e.unenrolled_at IS NOT NULL THEN 'unenrolled'
      WHEN e.unenroll_last_error IS NOT NULL THEN 'failed'
      WHEN e.unenroll_token_hash IS NOT NULL THEN 'pending'
      ELSE 'not_required'
    END,
    'unenrollReason', e.unenroll_reason,
    'unenrollRequestedAt', e.unenroll_requested_at,
    'unenrollTokenExpiresAt', e.unenroll_token_expires_at,
    'unenrollLastError', e.unenroll_last_error,
    'unenrolledAt', e.unenrolled_at,
    'logCount', (SELECT count(*)::int FROM enrollment_logs l WHERE l.enrollment_id = e.id),
    'scripts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', es.script_kind,
        'platform', es.platform,
        'status', es.status,
        'startedAt', es.started_at,
        'finishedAt', es.finished_at,
        'lastError', es.last_error
      ) ORDER BY es.script_kind, es.platform)
      FROM enrollment_scripts es WHERE es.enrollment_id = e.id
    ), '[]'::jsonb)
  ) ORDER BY e.created_at DESC)
  FROM enrollments e WHERE e.tunnel_id = s.id
), '[]'::jsonb)`;

// Shared with the drawer's own polling condition (TunnelDrawer.tsx,
// tunnelNeedsFastPolling) so the tunnel list and an open drawer refresh on the
// exact same signal instead of two conditions silently drifting apart.
const hasPendingActivityExpression = `(
  EXISTS (SELECT 1 FROM tunnel_command_executions ce WHERE ce.tunnel_id = s.id AND ce.status IN ('scheduled', 'running'))
  OR EXISTS (
    SELECT 1 FROM enrollments e
     WHERE e.tunnel_id = s.id AND e.deleted_at IS NULL
       AND e.unenroll_token_hash IS NOT NULL AND e.unenrolled_at IS NULL AND e.unenroll_last_error IS NULL
  )
)`;

const commandAgentJson = `(
  SELECT jsonb_build_object(
    'enabled', true,
    'hostname', p.hostname,
    'path', r.path,
    'endpoint', 'https://' || p.hostname || r.path,
    'status', ca.status,
    'lastSeenAt', ca.last_seen_at,
    'lastError', ca.last_error
  )
    FROM tunnel_publications p
    JOIN tunnel_routes r ON r.publication_id = p.id AND r.route_kind = 'command_agent'
    JOIN tunnel_command_agents ca ON ca.tunnel_id = s.id
   WHERE p.tunnel_id = s.id
   ORDER BY p.created_at, r.sort_order, r.created_at
   LIMIT 1
)`;

const commandExecutionsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', ce.id,
    'enrollmentId', ce.enrollment_id,
    'scriptType', ce.script_type,
    'scriptId', ce.script_id,
    'scriptVersionId', ce.script_version_id,
    'savedScriptId', ce.saved_script_id,
    'savedScriptVersionId', ce.saved_script_version_id,
    'savedAt', ce.saved_at,
    'bulkExecutionId', ce.bulk_execution_id,
    'scriptName', COALESCE(ce.script_name, ce.name, 'inline'),
    'scriptVersion', COALESCE(ce.script_version_number, ce.version),
    'platform', COALESCE(ce.script_platform, ce.platform),
    'language', COALESCE(ce.script_language, ce.language),
    'script', ce.script,
    'timeoutMs', ce.timeout_ms,
    'status', ce.status,
    'taskId', ce.task_id,
    'processId', ce.process_id,
    'createdAt', ce.created_at,
    'startedAt', ce.started_at,
    'finishedAt', ce.finished_at,
    'elapsedMs', ce.elapsed_ms,
    'exitCode', ce.exit_code,
    'stdout', ce.stdout,
    'stderr', ce.stderr,
    'error', ce.error,
    'requestedBy', ce.username,
    'environmentVariables', ce.environment_variables,
    'argumentSources', ce.argument_sources
  ) ORDER BY ce.created_at DESC)
  FROM LATERAL (
    SELECT ce.*, u.username, sv.version, ms.id AS script_id, ms.name, ms.platform, ms.language
      FROM tunnel_command_executions ce
      LEFT JOIN users u ON u.id = ce.requested_by
      LEFT JOIN managed_script_versions sv ON sv.id = ce.script_version_id
      LEFT JOIN managed_scripts ms ON ms.id = sv.script_id
     WHERE ce.tunnel_id = s.id
     ORDER BY ce.created_at DESC
     LIMIT 50
  ) ce
), '[]'::jsonb)`;

function preparePublications(
  tunnelCode: string,
  zoneName: string,
  publications: z.infer<typeof publicationsSchema>
) {
  const baseLabel = slugifyLabel(tunnelCode);
  return publications.map((publication) => ({
    ...publication,
    routes: publication.routes.map((route) => ({
      ...route,
      serviceUrl: route.kind === "command_agent" ? COMMAND_AGENT_SERVICE_URL : route.serviceUrl!
    })),
    hostname: `${publication.customLabel || (publication.suffix ? `${baseLabel}-${publication.suffix}` : baseLabel)}.${zoneName}`
  }));
}

export async function tunnelRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tunnels/tenant-codes", { preHandler: requireAuth }, async () => {
    const result = await pool.query("SELECT DISTINCT tenant_code AS \"tenantCode\" FROM tunnels ORDER BY tenant_code");
    return { tenantCodes: result.rows.map((row) => row.tenantCode as string) };
  });

  app.get("/api/tunnels", { preHandler: requireAuth }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    appendNameFilter(conditions, values, ["s.display_name", "s.tunnel_code"], query);
    if (query.search) {
      values.push(`%${query.search}%`);
      conditions.push(`(s.tunnel_code ILIKE $${values.length} OR s.tenant_code ILIKE $${values.length} OR s.display_name ILIKE $${values.length} OR s.hostname ILIKE $${values.length} OR EXISTS (SELECT 1 FROM tunnel_publications p WHERE p.tunnel_id = s.id AND p.hostname ILIKE $${values.length}))`);
    }
    if (query.tenantCode) {
      values.push(`%${query.tenantCode}%`);
      conditions.push(`s.tenant_code ILIKE $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`${onboardingStatusExpression} = $${values.length}`);
    }
    if (query.cfTunnelStatus) {
      values.push(query.cfTunnelStatus);
      conditions.push(`s.cf_tunnel_status = $${values.length}`);
    }
    if (query.enrollmentStatus) {
      values.push(query.enrollmentStatus);
      conditions.push(`${onboardingStatusExpression} = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await pool.query(`SELECT count(*)::int AS total FROM tunnels s ${latestEnrollmentJoin} ${where}`, values);
    const total = countResult.rows[0]?.total as number ?? 0;
    const offset = (query.page - 1) * query.pageSize;
    const pageValues = [...values, query.pageSize, offset];
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const result = await pool.query(`
      SELECT s.id, s.tenant_code AS "tenantCode", s.tunnel_code AS "tunnelCode", s.display_name AS "displayName", s.execution_variables AS "executionVariables",
             s.origin_url AS "originUrl", s.hostname, s.cf_tunnel_id AS "cfTunnelId", s.cf_tunnel_name AS "cfTunnelName",
             s.cf_tunnel_status AS "cfTunnelStatus", ${onboardingStatusExpression} AS "onboardingStatus",
             latest_enrollment.status AS "latestEnrollmentStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.ssh_status AS "sshStatus", s.ssh_target_ip::text AS "sshTargetIp", s.ssh_port AS "sshPort",
             s.ssh_username AS "sshUsername", s.ssh_url AS "sshUrl", s.ssh_last_error AS "sshLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.waf_warning AS "wafWarning",
             s.created_at AS "createdAt", a.id AS "accountId", a.cf_account_id AS "cfAccountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications,
             ${commandAgentJson} AS "commandAgent",
             ${hasPendingActivityExpression} AS "hasPendingActivity"
        FROM tunnels s
        JOIN cloudflare_accounts a ON a.id = s.account_id
        JOIN zones z ON z.id = s.zone_id
        ${latestEnrollmentJoin}
        ${where}
       ORDER BY s.created_at DESC
       LIMIT $${limitParameter} OFFSET $${offsetParameter}
    `, pageValues);
    return {
      tunnels: result.rows,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize))
      }
    };
  });

  app.get("/api/tunnels/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT s.id, s.tenant_code AS "tenantCode", s.tunnel_code AS "tunnelCode", s.display_name AS "displayName", s.execution_variables AS "executionVariables",
             s.origin_url AS "originUrl", s.hostname, s.cf_tunnel_id AS "cfTunnelId", s.cf_tunnel_name AS "cfTunnelName",
             s.cf_tunnel_status AS "cfTunnelStatus", ${onboardingStatusExpression} AS "onboardingStatus",
             latest_enrollment.status AS "latestEnrollmentStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.ssh_status AS "sshStatus", s.ssh_target_ip::text AS "sshTargetIp", s.ssh_port AS "sshPort",
             s.ssh_username AS "sshUsername", s.ssh_url AS "sshUrl", s.ssh_last_error AS "sshLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.waf_warning AS "wafWarning",
             s.created_at AS "createdAt", a.id AS "accountId", a.cf_account_id AS "cfAccountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications,
             ${enrollmentsJson} AS enrollments,
             ${commandAgentJson} AS "commandAgent",
             ${commandExecutionsJson} AS "commandExecutions",
             ${hasPendingActivityExpression} AS "hasPendingActivity"
        FROM tunnels s
        JOIN cloudflare_accounts a ON a.id = s.account_id
        JOIN zones z ON z.id = s.zone_id
        ${latestEnrollmentJoin}
       WHERE s.id = $1
    `, [id]);
    if (!result.rowCount) return reply.code(404).send({ error: "Tunnel not found" });
    return { tunnel: result.rows[0] };
  });

  app.get("/api/tunnels/:id/enrollments", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = enrollmentListSchema.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const [tunnelResult, enrollmentResult, countResult] = await Promise.all([
      pool.query("SELECT 1 FROM tunnels WHERE id = $1", [id]),
      pool.query(
        `SELECT e.id,
                NULLIF(e.host_info->>'machineName', '') AS "computerName",
                e.deleted_at IS NULL
                  AND e.unenrolled_at IS NULL
                  AND e.status IN ('ready', 'installed')
                  AND e.id = (
                    SELECT current_enrollment.id
                      FROM enrollments current_enrollment
                     WHERE current_enrollment.tunnel_id = $1
                       AND current_enrollment.deleted_at IS NULL
                       AND current_enrollment.unenrolled_at IS NULL
                       AND current_enrollment.status IN ('ready', 'installed')
                     ORDER BY COALESCE(current_enrollment.installed_at, current_enrollment.claimed_at, current_enrollment.created_at) DESC
                     LIMIT 1
                  ) AS "isCurrent",
                e.deleted_at AS "deletedAt", e.status,
                CASE WHEN e.platform = 'windows' THEN 'windows' WHEN e.platform IS NOT NULL THEN 'unix' ELSE null END AS platform,
                e.platform AS environment, e.created_at AS "createdAt", e.expires_at AS "expiresAt",
                e.claimed_at AS "claimedAt", e.installed_at AS "installedAt", e.last_error AS "lastError",
                e.host_info AS "hostInfo", e.execution_variables AS "executionVariables",
                CASE
                  WHEN e.unenrolled_at IS NOT NULL THEN 'unenrolled'
                  WHEN e.unenroll_last_error IS NOT NULL THEN 'failed'
                  WHEN e.unenroll_token_hash IS NOT NULL THEN 'pending'
                  ELSE 'not_required'
                END AS "unenrollStatus",
                e.unenroll_reason AS "unenrollReason", e.unenroll_requested_at AS "unenrollRequestedAt",
                e.unenroll_token_expires_at AS "unenrollTokenExpiresAt", e.unenroll_last_error AS "unenrollLastError",
                e.unenrolled_at AS "unenrolledAt",
                (SELECT count(*)::int FROM enrollment_logs l WHERE l.enrollment_id = e.id) AS "logCount",
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'kind', es.script_kind,
                    'platform', es.platform,
                    'status', es.status,
                    'startedAt', es.started_at,
                    'finishedAt', es.finished_at,
                    'lastError', es.last_error
                  ) ORDER BY es.script_kind, es.platform)
                    FROM enrollment_scripts es WHERE es.enrollment_id = e.id
                ), '[]'::jsonb) AS scripts
           FROM enrollments e
          WHERE e.tunnel_id = $1
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT $2 OFFSET $3`,
        [id, query.pageSize, offset]
      ),
      pool.query("SELECT count(*)::int AS total FROM enrollments WHERE tunnel_id = $1", [id])
    ]);
    if (!tunnelResult.rowCount) return reply.code(404).send({ error: "Tunnel not found" });
    const total = countResult.rows[0]?.total as number ?? 0;
    return {
      enrollments: enrollmentResult.rows,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize))
      }
    };
  });

  app.get("/api/tunnels/:tunnelId/routes/:routeId/waf", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, routeId } = z.object({ tunnelId: z.string().uuid(), routeId: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `SELECT r.id, r.path, r.route_kind AS "routeKind", r.waf_enabled, r.waf_allowed_ips, r.waf_ruleset_id, r.waf_rule_id, p.hostname,
              a.provider_mode AS "providerMode"
         FROM tunnel_routes r
         JOIN tunnel_publications p ON p.id = r.publication_id
         JOIN tunnels s ON s.id = p.tunnel_id
         JOIN cloudflare_accounts a ON a.id = s.account_id
        WHERE p.tunnel_id = $1 AND r.id = $2`,
      [tunnelId, routeId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Ingress route not found" });
    const row = result.rows[0];
    const publicHostname = await cloudflareManPublicHostname();
    const remoteAgentPath = isCfmanRemoteAgentPath(row.hostname, row.path, publicHostname);
    const protectsCloudflareMan = !remoteAgentPath && isCloudflareManPublicHostname(row.hostname, publicHostname);
    const mandatory = row.routeKind === "command_agent";
    const storedIps = (row.waf_allowed_ips ?? []) as string[];
    // Resolved best-effort so the "CFMan origin" quick-add option can
    // still be offered without breaking the read for routes that already have
    // their own allowed IPs configured.
    const cloudflareManIps = await defaultWafAllowedIps(row.providerMode).catch(() => [] as string[]);
    // The operator's own browser IP, offered as a one-click allow-list entry -
    // distinct from cloudflareManIps, which is the server's own outbound IP.
    const currentIp = isIP(request.ip) ? `${request.ip}/${request.ip.includes(":") ? 128 : 32}` : null;
    try {
      const allowedIps = await resolveWafAllowedIps(storedIps.length ? storedIps : cloudflareManIps, row.providerMode);
      return {
        waf: {
          enabled: mandatory ? true : row.waf_enabled,
          allowedIps, rulesetId: row.waf_ruleset_id, ruleId: row.waf_rule_id, defaulted: !storedIps.length,
          cloudflareManIps, currentIp, protectsCloudflareMan, mandatory, remoteAgentPath,
          remoteAgentWarning: remoteAgentPath ? CFMAN_REMOTE_AGENT_WAF_WARNING : null
        }
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Unable to resolve WAF source IP" });
    }
  });

  app.patch("/api/tunnels/:tunnelId/routes/:routeId/waf", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, routeId } = z.object({ tunnelId: z.string().uuid(), routeId: z.string().uuid() }).parse(request.params);
    const body = routeWafSchema.parse(request.body ?? {});
    const result = await pool.query(
      `SELECT r.id, r.path, r.route_kind AS "routeKind", r.waf_allowed_ips, r.waf_ruleset_id,
              p.hostname, s.zone_id AS "zoneId", z.cf_zone_id AS "cfZoneId",
              a.id AS "accountRowId", a.cf_account_id AS "cfAccountId", a.api_token_encrypted AS "apiTokenEncrypted",
              a.provider_mode AS "providerMode"
         FROM tunnel_routes r
         JOIN tunnel_publications p ON p.id = r.publication_id
         JOIN tunnels s ON s.id = p.tunnel_id
         JOIN cloudflare_accounts a ON a.id = s.account_id
         JOIN zones z ON z.id = s.zone_id
        WHERE p.tunnel_id = $1 AND r.id = $2`,
      [tunnelId, routeId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Ingress route not found" });
    const route = result.rows[0] as {
      path: string;
      routeKind: "service" | "command_agent";
      hostname: string;
      zoneId: string;
      cfZoneId: string | null;
      accountRowId: string;
      cfAccountId: string | null;
      apiTokenEncrypted: string | null;
      providerMode: "live" | "mock";
      waf_allowed_ips: string[] | null;
      waf_ruleset_id: string | null;
    };
    if (route.routeKind === "command_agent" && !body.enabled) {
      return reply.code(409).send({ error: "WAF cannot be disabled on the command agent route - it is the tunnel's remote command execution endpoint and must always stay protected." });
    }
    const publicHostname = await cloudflareManPublicHostname();
    const remoteAgentPath = isCfmanRemoteAgentPath(route.hostname, route.path, publicHostname);
    if (body.enabled && !remoteAgentPath && isCloudflareManPublicHostname(route.hostname, publicHostname)) {
      return reply.code(409).send({ error: "Source-IP WAF cannot be enabled on the CFMan public hostname" });
    }
    const invalidInput = body.allowedIps.find((value) => !isValidIpOrCidr(value));
    if (invalidInput) return reply.code(400).send({ error: `Invalid WAF allowed IP or CIDR: ${invalidInput}` });
    const allowedIps = body.enabled
      ? await resolveWafAllowedIps(body.allowedIps, route.providerMode)
      : [...new Set(body.allowedIps.length ? body.allowedIps : (route.waf_allowed_ips ?? []))];
    const invalid = allowedIps.find((value) => !isValidIpOrCidr(value));
    if (invalid) return reply.code(400).send({ error: `Invalid WAF allowed IP or CIDR: ${invalid}` });
    if (body.enabled && !allowedIps.length) return reply.code(400).send({ error: "At least one allowed IP or CIDR is required when WAF is enabled" });
    try {
      await pool.query(
        "UPDATE tunnel_routes SET waf_enabled = $1, waf_allowed_ips = $2, updated_at = now() WHERE id = $3",
        [body.enabled, allowedIps, routeId]
      );
      const client = new CloudflareClient(
        route.cfAccountId ?? route.accountRowId,
        route.apiTokenEncrypted ? decryptSecret(route.apiTokenEncrypted) : "mock",
        route.providerMode
      );
      // Rebuilds the zone's single merged WAF rule from every route that
      // needs it (see reconcileZoneWaf) - not just this one - so this route's
      // change lands alongside whatever every other tunnel in the zone
      // already has, instead of overwriting them.
      const { warning } = await reconcileZoneWaf(client, route.zoneId, route.cfZoneId, route.providerMode);
      const refreshed = await pool.query(
        "SELECT waf_enabled, waf_allowed_ips, waf_ruleset_id, waf_rule_id FROM tunnel_routes WHERE id = $1",
        [routeId]
      );
      const state = refreshed.rows[0] as { waf_enabled: boolean; waf_allowed_ips: string[] | null; waf_ruleset_id: string | null; waf_rule_id: string | null };
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: body.enabled ? "route.waf_enabled" : "route.waf_disabled",
        entityType: "tunnel_route",
        entityId: routeId,
        details: { tunnelId, hostname: route.hostname, path: route.path, allowedIps: state.waf_allowed_ips, rulesetId: state.waf_ruleset_id, ruleId: state.waf_rule_id, warning }
      });
      return {
        success: true,
        waf: { enabled: state.waf_enabled, allowedIps: state.waf_allowed_ips ?? [], rulesetId: state.waf_ruleset_id, ruleId: state.waf_rule_id },
        warning
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Unable to apply route WAF" });
    }
  });

  // For a tunnel that is CFMan's own self-hosted target (one of its
  // publications shares CFMan's public hostname): backfills the remote-agent
  // routes (see CFMAN_REMOTE_AGENT_PATHS) if any are missing, then rebuilds
  // the zone's merged WAF rule so this tunnel's routes are correctly folded
  // in. Read the result to answer "are the WAF rules and routes already
  // correct" - it's idempotent, so calling it when everything is already
  // right is just a no-op confirmation.
  app.post("/api/tunnels/:id/reconcile-cfman-self", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const publicHostname = await cloudflareManPublicHostname();
    const result = await pool.query(
      `SELECT p.hostname, s.zone_id AS "zoneId", z.cf_zone_id AS "cfZoneId",
              a.id AS "accountRowId", a.cf_account_id AS "cfAccountId", a.api_token_encrypted AS "apiTokenEncrypted",
              a.provider_mode AS "providerMode"
         FROM tunnel_publications p
         JOIN tunnels s ON s.id = p.tunnel_id
         JOIN cloudflare_accounts a ON a.id = s.account_id
         JOIN zones z ON z.id = s.zone_id
        WHERE p.tunnel_id = $1`,
      [id]
    );
    const row = result.rows.find((candidate) => isCloudflareManPublicHostname(candidate.hostname, publicHostname));
    if (!result.rowCount) return reply.code(404).send({ error: "Tunnel not found" });
    if (!row) return reply.code(409).send({ error: "This tunnel is not CFMan's own self-hosted tunnel" });
    try {
      const routes = await ensureCloudflareManRemoteAgentRoutes(row.hostname);
      const client = new CloudflareClient(
        row.cfAccountId ?? row.accountRowId,
        row.apiTokenEncrypted ? decryptSecret(row.apiTokenEncrypted) : "mock",
        row.providerMode
      );
      const { warning } = await reconcileZoneWaf(client, row.zoneId, row.cfZoneId, row.providerMode);
      return { hostname: row.hostname, routes, warning };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Unable to reconcile CFMan's self-hosted WAF configuration" });
    }
  });

  app.delete("/api/tunnels/:tunnelId/enrollments/:enrollmentId", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, enrollmentId } = z.object({
      tunnelId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    await pool.query(
      `UPDATE enrollment_diagnostic_runs
          SET status = 'failed', finished_at = now()
        WHERE enrollment_id = $1 AND status IN ('pending', 'running') AND expires_at <= now()`,
      [enrollmentId]
    );
    const deleted = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT e.id, e.deleted_at,
                (SELECT count(*)::int FROM enrollment_logs l WHERE l.enrollment_id = e.id) AS log_count,
                e.deleted_at IS NULL
                AND e.unenrolled_at IS NULL
                AND e.status IN ('ready', 'installed')
                AND e.id = (
                  SELECT current_enrollment.id
                    FROM enrollments current_enrollment
                   WHERE current_enrollment.tunnel_id = e.tunnel_id
                     AND current_enrollment.deleted_at IS NULL
                     AND current_enrollment.unenrolled_at IS NULL
                     AND current_enrollment.status IN ('ready', 'installed')
                   ORDER BY COALESCE(current_enrollment.installed_at, current_enrollment.claimed_at, current_enrollment.created_at) DESC
                   LIMIT 1
                ) AS is_current
           FROM enrollments e
          WHERE e.tunnel_id = $1 AND e.id = $2
          FOR UPDATE`,
        [tunnelId, enrollmentId]
      );
      const enrollment = result.rows[0];
      if (!enrollment) return { kind: "missing" as const };
      if (enrollment.is_current) return { kind: "current" as const };
      const deletedAt = new Date().toISOString();
      // This enrollment may have superseded another still-active enrollment (marking it
      // pending unenroll) before it was ever claimed/installed. Deleting it aborts that
      // switchover, so revert the superseded enrollment back to its normal active state
      // instead of leaving it stuck showing "unenroll pending" forever.
      const reverted = await client.query(
        `UPDATE enrollments
            SET unenroll_token_hash = null, unenroll_token_encrypted = null,
                unenroll_token_expires_at = null, unenroll_cf_tunnel_id = null,
                unenroll_requested_at = null, unenroll_last_error = null,
                superseded_by_enrollment_id = null, updated_at = now()
          WHERE tunnel_id = $1 AND superseded_by_enrollment_id = $2 AND unenrolled_at IS NULL
          RETURNING id`,
        [tunnelId, enrollmentId]
      );
      if (reverted.rowCount) {
        await client.query(
          "DELETE FROM enrollment_scripts WHERE enrollment_id = ANY($1::uuid[]) AND script_kind = 'unenroll'",
          [reverted.rows.map((row) => row.id)]
        );
      }
      await client.query("DELETE FROM enrollments WHERE tunnel_id = $1 AND id = $2", [tunnelId, enrollmentId]);
      const activeEnrollment = await client.query(
        `SELECT 1
           FROM enrollments
          WHERE tunnel_id = $1
            AND deleted_at IS NULL
            AND unenrolled_at IS NULL
            AND status IN ('ready', 'installed')
          ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC
          LIMIT 1`,
        [tunnelId]
      );
      await client.query(
        `UPDATE tunnels
            SET onboarding_status = CASE WHEN $2 THEN 'verified' ELSE 'revoked' END,
                last_error = null, updated_at = now()
          WHERE id = $1 AND onboarding_status = 'waiting_for_new_enrollment'`,
        [tunnelId, Boolean(activeEnrollment.rowCount)]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.deleted",
        entityType: "enrollment",
        entityId: enrollmentId,
        details: {
          tunnelId,
          hardDelete: true,
          logCount: enrollment.log_count,
          revertedSupersededEnrollmentIds: reverted.rows.map((row) => row.id)
        }
      }, client);
      return { kind: "deleted" as const, deletedAt, logCount: enrollment.log_count as number };
    });
    if (deleted.kind === "missing") return reply.code(404).send({ error: "Enrollment not found" });
    if (deleted.kind === "current") return reply.code(409).send({ error: "The current connected enrollment cannot be deleted" });
    return { success: true, deletedAt: deleted.deletedAt, hardDeleted: true, logCount: deleted.logCount, alreadyDeleted: false };
  });

  app.post("/api/tunnels/:tunnelId/enrollments/:enrollmentId/unenroll", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, enrollmentId } = z.object({
      tunnelId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    const body = unenrollmentRequestSchema.parse(request.body ?? {});
    const rawToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);
    const issued = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT e.id, e.created_at, e.status, e.platform, e.unenrolled_at, e.deleted_at,
                e.status IN ('ready', 'installed')
                AND e.unenrolled_at IS NULL
                AND e.deleted_at IS NULL
                AND e.id = (
                  SELECT current_enrollment.id
                    FROM enrollments current_enrollment
                   WHERE current_enrollment.tunnel_id = e.tunnel_id
                     AND current_enrollment.deleted_at IS NULL
                     AND current_enrollment.unenrolled_at IS NULL
                     AND current_enrollment.status IN ('ready', 'installed')
                   ORDER BY COALESCE(current_enrollment.installed_at, current_enrollment.claimed_at, current_enrollment.created_at) DESC
                   LIMIT 1
                ) AS is_current
           FROM enrollments e
          WHERE e.tunnel_id = $1 AND e.id = $2
          FOR UPDATE`,
        [tunnelId, enrollmentId]
      );
      const enrollment = result.rows[0];
      if (!enrollment) return { kind: "missing" as const };
      if (!enrollment.is_current) return { kind: "not_current" as const };
      await client.query(
        `UPDATE enrollments
            SET unenroll_token_hash = $1, unenroll_token_encrypted = $2, unenroll_token_expires_at = $3,
                unenroll_cf_tunnel_id = (SELECT cf_tunnel_id FROM tunnels WHERE id = $5),
                unenroll_requested_at = now(), unenrolled_at = null,
                unenroll_reason = null, unenroll_last_error = null, updated_at = now()
          WHERE id = $4`,
        [hashToken(rawToken), encryptSecret(rawToken), expiresAt, enrollmentId, tunnelId]
      );
      await client.query(
        `INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status)
         VALUES ($1, 'unenroll', 'windows', 'available'), ($1, 'unenroll', 'unix', 'available')
         ON CONFLICT (enrollment_id, script_kind, platform) DO UPDATE SET
           status = 'available', started_at = null, finished_at = null, last_error = null, updated_at = now()`,
        [enrollmentId]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.unenroll_issued",
        entityType: "enrollment",
        entityId: enrollmentId,
        details: { tunnelId, expiresAt }
      }, client);
      return { kind: "issued" as const, createdAt: enrollment.created_at as string, platform: enrollment.platform as string | null };
    });
    if (issued.kind === "missing") return reply.code(404).send({ error: "Enrollment not found" });
    if (issued.kind === "not_current") return reply.code(409).send({ error: "Only the current connected enrollment can be unenrolled" });
    const urls = await unenrollmentUrls(rawToken);
    let automatic: {
      requested: boolean;
      status: "scheduled" | "failed" | "unavailable";
      executionId: string | null;
      platform: "windows" | "unix" | null;
      error: string | null;
    } | undefined;
    if (body.automatic) {
      const platform = issued.platform === "windows"
        ? "windows"
        : issued.platform && ["linux", "darwin", "unix"].includes(issued.platform)
          ? "unix"
          : null;
      const agent = await getCommandAgentConfig(tunnelId);
      if (!platform) {
        automatic = { requested: true, status: "unavailable", executionId: null, platform: null, error: "The connected enrollment platform is unknown" };
      } else if (!agent || agent.status !== "ready") {
        automatic = { requested: true, status: "unavailable", executionId: null, platform, error: "The command agent is not ready" };
      } else {
        const script = automaticUnenrollmentScript(platform, platform === "windows" ? urls.powershell : urls.shell);
        const executionHandle = await createCommandExecution({
          tunnelId,
          enrollmentId,
          scriptVersionId: null,
          requestedBy: request.authUser!.id,
          script,
          timeoutMs: 30_000,
          scriptType: "inline",
          scriptName: "Automatic unenrollment",
          scriptPlatform: platform,
          scriptLanguage: platform === "windows" ? "powershell" : "sh",
          scriptVersion: null
        });
        try {
          const execution = await executeTunnelScript(tunnelId, script, 30_000, executionHandle);
          automatic = execution?.scheduled || execution?.result?.success
            ? { requested: true, status: "scheduled", executionId: executionHandle.executionId, platform, error: null }
            : { requested: true, status: "failed", executionId: executionHandle.executionId, platform, error: execution?.result?.stderr || "The command agent did not schedule cleanup" };
        } catch (error) {
          automatic = { requested: true, status: "failed", executionId: executionHandle.executionId, platform, error: error instanceof Error ? error.message : "Automatic unenrollment failed" };
        }
      }
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.unenroll_automatic_requested",
        entityType: "enrollment",
        entityId: enrollmentId,
        details: { tunnelId, executionId: automatic.executionId, platform: automatic.platform, status: automatic.status, error: automatic.error }
      });
      if (automatic.status !== "scheduled") {
        await pool.query(
          "UPDATE enrollments SET unenroll_last_error = $1, updated_at = now() WHERE id = $2",
          [automatic.error, enrollmentId]
        );
      }
    }
    return {
      tunnelId,
      enrollmentId,
      createdAt: issued.createdAt,
      expiresAt,
      urls,
      ...(automatic ? { automatic } : {})
    };
  });

  app.get("/api/tunnels/:id/delete-preflight", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const context = await loadTunnelDeleteContext(pool, id);
    if (!context) return reply.code(404).send({ error: "Tunnel not found" });
    return buildTunnelDeletePreflight(context);
  });

  app.delete("/api/tunnels/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = deleteTunnelSchema.parse(request.body ?? {});
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lockedTunnel = await client.query("SELECT id FROM tunnels WHERE id = $1 FOR UPDATE", [id]);
      if (!lockedTunnel.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Tunnel not found" });
      }
      const context = await loadTunnelDeleteContext(client, id);
      if (!context) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Tunnel not found" });
      }
      const preflight = buildTunnelDeletePreflight(context);
      const cloudflareCheck = preflight.checks.find((check) => check.id === "cloudflare");
      if (!cloudflareCheck?.ok) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Cloudflare cleanup is not ready", preflight });
      }
      if (!preflight.canDelete && (!body.force || body.confirmName !== context.displayName)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Tunnel safety checks require an explicit name confirmation", preflight, requiresNameConfirmation: true });
      }
      await cleanupTunnelResources(context);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "tunnel.deleted",
        entityType: "tunnel",
        entityId: id,
        details: {
          displayName: context.displayName,
          tunnelCode: context.tunnelCode,
          forced: !preflight.canDelete,
          cfTunnelId: context.cfTunnelId,
          publicationCount: context.publications.length
        }
      }, client);
      await client.query("DELETE FROM tunnels WHERE id = $1", [id]);
      await client.query("COMMIT");
      return reply.code(204).send();
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message : "Tunnel deletion failed";
      return reply.code(502).send({ error: `Tunnel resources could not be fully deleted: ${message}` });
    } finally {
      client.release();
    }
  });

  app.get("/api/tunnels/:tunnelId/enrollments/:enrollmentId/logs", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, enrollmentId } = z.object({
      tunnelId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    const result = await pool.query(
      `SELECT l.id, l.level, l.step, l.message, l.metadata, l.phase,
              l.diagnostic_run_id AS "diagnosticRunId", l.created_at AS "createdAt"
         FROM enrollment_logs l
         JOIN enrollments e ON e.id = l.enrollment_id
        WHERE e.tunnel_id = $1 AND e.id = $2
        ORDER BY l.created_at ASC, l.id ASC`,
      [tunnelId, enrollmentId]
    );
    const enrollment = await pool.query("SELECT 1 FROM enrollments WHERE id = $1 AND tunnel_id = $2", [enrollmentId, tunnelId]);
    if (!enrollment.rowCount) return reply.code(404).send({ error: "Enrollment not found" });
    const diagnosticRuns = await pool.query(
      `SELECT id, platform, status, expires_at AS "expiresAt", created_at AS "createdAt",
              started_at AS "startedAt", finished_at AS "finishedAt"
         FROM enrollment_diagnostic_runs
        WHERE enrollment_id = $1
        ORDER BY created_at DESC, id DESC`,
      [enrollmentId]
    );
    return {
      logs: result.rows,
      diagnosticRuns: diagnosticRuns.rows,
      hasActiveDiagnostics: diagnosticRuns.rows.some((run) => ["pending", "running"].includes(run.status))
    };
  });

  app.get("/api/tunnels/:tunnelId/enrollments/:enrollmentId/install-script", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, enrollmentId } = z.object({
      tunnelId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    const result = await pool.query(
      "SELECT token_encrypted FROM enrollments WHERE id = $1 AND tunnel_id = $2",
      [enrollmentId, tunnelId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Enrollment not found" });
    const row = result.rows[0] as { token_encrypted: string | null };
    if (!row.token_encrypted) return { powershell: null, shell: null };
    const token = decryptSecret(row.token_encrypted);
    const publicBaseUrl = await getPublicBaseUrl();
    return {
      powershell: `${publicBaseUrl}/e/${token}/install.ps1`,
      shell: `${publicBaseUrl}/e/${token}/install.sh`
    };
  });

  app.get("/api/tunnels/:tunnelId/enrollments/:enrollmentId/unenroll-script", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, enrollmentId } = z.object({
      tunnelId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    const result = await pool.query(
      `SELECT unenroll_token_encrypted, unenrolled_at, unenroll_token_expires_at
         FROM enrollments WHERE id = $1 AND tunnel_id = $2`,
      [enrollmentId, tunnelId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Enrollment not found" });
    const row = result.rows[0] as { unenroll_token_encrypted: string | null; unenrolled_at: string | null; unenroll_token_expires_at: string | null };
    const stillValid = row.unenroll_token_encrypted
      && !row.unenrolled_at
      && row.unenroll_token_expires_at
      && new Date(row.unenroll_token_expires_at) > new Date();
    if (!stillValid) return { powershell: null, shell: null };
    const token = decryptSecret(row.unenroll_token_encrypted!);
    const publicBaseUrl = await getPublicBaseUrl();
    return {
      powershell: `${publicBaseUrl}/e/${token}/unenroll.ps1`,
      shell: `${publicBaseUrl}/e/${token}/unenroll.sh`
    };
  });

  app.get("/api/tunnels/:id/command-executions", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = commandExecutionListSchema.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const values: unknown[] = [id];
    const conditions = ["ce.tunnel_id = $1"];
    if (query.search) {
      values.push(query.search);
      conditions.push(`strpos(lower(concat_ws(' ', ce.script_name, ms.name, ms.description, saved_ms.name, saved_ms.description, st.display_name, st.tenant_code, st.tunnel_code, u.username)), lower($${values.length})) > 0`);
    }
    if (query.from) {
      values.push(query.from);
      conditions.push(`ce.created_at >= $${values.length}::timestamptz`);
    }
    if (query.to) {
      values.push(query.to);
      conditions.push(`ce.created_at <= $${values.length}::timestamptz`);
    }
    const where = conditions.join(" AND ");
    const joins = `
           LEFT JOIN users u ON u.id = ce.requested_by
           LEFT JOIN managed_script_versions sv ON sv.id = ce.script_version_id
           LEFT JOIN managed_scripts ms ON ms.id = sv.script_id
           LEFT JOIN managed_script_versions saved_sv ON saved_sv.id = ce.saved_script_version_id
           LEFT JOIN managed_scripts saved_ms ON saved_ms.id = saved_sv.script_id`;
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const [tunnelResult, executionResult, statsResult] = await Promise.all([
      pool.query("SELECT 1 FROM tunnels WHERE id = $1", [id]),
      pool.query(
        `SELECT ce.id,
                ce.enrollment_id AS "enrollmentId",
                ce.script_type AS "scriptType",
                ms.id AS "scriptId",
                ce.script_version_id AS "scriptVersionId",
                ce.saved_script_id AS "savedScriptId",
                ce.saved_script_version_id AS "savedScriptVersionId",
                ce.saved_at AS "savedAt",
                ce.bulk_execution_id AS "bulkExecutionId",
                COALESCE(ce.script_name, ms.name, 'Inline script') AS "scriptName",
                COALESCE(ce.script_version_number, sv.version) AS "scriptVersion",
                COALESCE(ce.script_platform, ms.platform) AS platform,
                COALESCE(ce.script_language, ms.language) AS language,
                ce.script, ce.environment_variables AS "environmentVariables", ce.argument_sources AS "argumentSources", COALESCE(sv.arguments, ce.inline_arguments) AS "scriptArguments", ce.timeout_ms AS "timeoutMs", ce.status, ce.task_id AS "taskId", ce.process_id AS "processId",
                ce.created_at AS "createdAt", ce.started_at AS "startedAt", ce.finished_at AS "finishedAt",
                ce.elapsed_ms AS "elapsedMs", ce.exit_code AS "exitCode",
                ce.stdout, ce.stderr, ce.error, u.username AS "requestedBy"
           FROM tunnel_command_executions ce
           JOIN tunnels st ON st.id = ce.tunnel_id
           ${joins}
          WHERE ${where}
          ORDER BY ce.created_at DESC, ce.id DESC
          LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        [...values, query.pageSize, offset]
      ),
      pool.query(
        `SELECT count(*)::int AS total,
                (count(*) FILTER (WHERE ce.status = 'succeeded'))::int AS succeeded,
                (count(*) FILTER (WHERE ce.status = 'failed'))::int AS failed,
                (count(*) FILTER (WHERE ce.status = 'timed_out'))::int AS "timedOut",
                (count(*) FILTER (WHERE ce.status = 'cancelled'))::int AS cancelled,
                (count(*) FILTER (WHERE ce.status = 'scheduled'))::int AS scheduled,
                (count(*) FILTER (WHERE ce.status = 'running'))::int AS running
           FROM tunnel_command_executions ce
           JOIN tunnels st ON st.id = ce.tunnel_id
           ${joins}
          WHERE ${where}`,
        values
      )
    ]);
    if (!tunnelResult.rowCount) return reply.code(404).send({ error: "Tunnel not found" });
    const summary = statsResult.rows[0];
    const total = summary.total as number;
    return {
      executions: executionResult.rows,
      summary,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize))
      }
    };
  });

  app.get("/api/tunnels/:tunnelId/command-executions/:executionId/logs", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, executionId } = z.object({ tunnelId: z.string().uuid(), executionId: z.string().uuid() }).parse(request.params);
    const query = commandExecutionLogListSchema.parse(request.query);
    const execution = await pool.query(
      `SELECT id, status, task_id AS "taskId", process_id AS "processId", stdout, stderr, error FROM tunnel_command_executions
        WHERE id = $1 AND tunnel_id = $2`,
      [executionId, tunnelId]
    );
    if (!execution.rowCount) return reply.code(404).send({ error: "Command execution not found" });
    const logs = await pool.query(
      `SELECT id, stream, line, sequence, created_at AS "createdAt"
         FROM tunnel_command_execution_logs
        WHERE execution_id = $1 AND id > $2
        ORDER BY id ASC LIMIT $3`,
      [executionId, query.after, query.limit]
    );
    return { execution: execution.rows[0], logs: logs.rows, nextAfter: logs.rows.at(-1)?.id ?? query.after };
  });

  app.post("/api/tunnels/:tunnelId/command-executions/:executionId/cancel", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, executionId } = z.object({ tunnelId: z.string().uuid(), executionId: z.string().uuid() }).parse(request.params);
    try {
      const result = await cancelCommandExecution(tunnelId, executionId);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "tunnel.command_execution_cancelled",
        entityType: "tunnel_command_execution",
        entityId: executionId,
        details: { tunnelId, taskId: result.taskId }
      });
      return reply.code(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to cancel command execution";
      const status = message === "Command execution not found" ? 404 : 409;
      return reply.code(status).send({ error: message });
    }
  });

  app.post("/api/tunnels/:id/commands/execute", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = executeScriptSchema.parse(request.body);
    const enrollmentResult = await pool.query(
      `SELECT id, platform
         FROM enrollments
        WHERE tunnel_id = $1
          AND status IN ('ready', 'installed')
          AND unenrolled_at IS NULL
          AND deleted_at IS NULL
        ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC
        LIMIT 1`,
      [id]
    );
    const enrollment = enrollmentResult.rows[0];
    if (!enrollment) return reply.code(409).send({ error: "This tunnel has no active enrollment" });
    const enrollmentPlatform = enrollment.platform === "windows" ? "windows" : "unix";
    let executionScript: string;
    let scriptType: "managed" | "inline";
    let scriptVersionId: string | null;
    let scriptName: string;
    let scriptVersion: number | null;
    let scriptPlatform: "windows" | "unix";
    let scriptLanguage: "powershell" | "bash" | "sh";
    let scriptId: string | null;
    let scriptArguments: ScriptArgument[] = [];
    let resolvedTimeoutMs = body.timeoutMs ?? 60_000;
    if (body.scriptVersionId) {
      const scriptVersionResult = await pool.query(
        `SELECT v.id, v.content, v.version, v.arguments, s.id AS script_id, s.name, s.platform, s.language,
                s.default_timeout_ms AS "defaultTimeoutMs"
          FROM managed_script_versions v
           JOIN managed_scripts s ON s.id = v.script_id
          WHERE v.id = $1`,
        [body.scriptVersionId]
      );
      const managedScript = scriptVersionResult.rows[0];
      if (!managedScript) return reply.code(404).send({ error: "Script version not found" });
      if (managedScript.platform !== enrollmentPlatform) {
        return reply.code(409).send({ error: `This script is for ${managedScript.platform}, but the active enrollment is ${enrollmentPlatform}` });
      }
      executionScript = managedScript.content;
      scriptType = "managed";
      scriptVersionId = managedScript.id;
      scriptId = managedScript.script_id;
      scriptName = managedScript.name;
      scriptVersion = managedScript.version;
      scriptPlatform = managedScript.platform;
      scriptLanguage = managedScript.language;
      scriptArguments = scriptArgumentsSchema.parse(managedScript.arguments);
      resolvedTimeoutMs = body.timeoutMs ?? managedScript.defaultTimeoutMs;
    } else {
      const inlineLanguage = body.language ?? (enrollmentPlatform === "windows" ? "powershell" : "bash");
      if (enrollmentPlatform === "windows" && inlineLanguage !== "powershell") {
        return reply.code(409).send({ error: "Windows inline scripts must use PowerShell" });
      }
      if (enrollmentPlatform === "unix" && inlineLanguage === "powershell") {
        return reply.code(409).send({ error: "Unix inline scripts must use Bash or sh" });
      }
      executionScript = body.inlineScript!;
      scriptType = "inline";
      scriptVersionId = null;
      scriptId = null;
      scriptName = body.name ?? "Inline script";
      scriptVersion = null;
      scriptPlatform = enrollmentPlatform;
      scriptLanguage = inlineLanguage;
      scriptArguments = body.arguments ?? [];
    }
    const agent = await getCommandAgentConfig(id);
    if (!agent) return reply.code(409).send({ error: "No command agent route is configured for this tunnel" });
    let argumentValues: ExecutionVariables;
    let argumentSources: ReturnType<typeof describeArgumentValueSources>;
    try {
      const available = await resolveAvailableVariablesForTunnel(id);
      argumentValues = resolveArgumentValues(scriptArguments, available.variables, body.argumentBindings);
      argumentSources = describeArgumentValueSources(scriptArguments, available.sources, body.argumentBindings);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Unable to resolve script arguments" });
    }
    const dispatchedScript = applyScriptArguments(executionScript, scriptLanguage, argumentValues);
    const executionHandle = await createCommandExecution({
      tunnelId: id,
      enrollmentId: enrollment.id,
      scriptVersionId,
      requestedBy: request.authUser!.id,
      script: executionScript,
      timeoutMs: resolvedTimeoutMs,
      scriptType,
      scriptName,
      scriptPlatform,
      scriptLanguage,
      scriptVersion,
      environmentVariables: argumentValues,
      argumentSources,
      inlineArguments: scriptType === "inline" ? scriptArguments : undefined
    });
    try {
      const result = await executeTunnelScript(id, dispatchedScript, resolvedTimeoutMs, executionHandle);
      if (!result) return reply.code(409).send({ error: "No command agent route is configured for this tunnel" });
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "tunnel.command_executed",
        entityType: "tunnel",
        entityId: id,
        details: { endpoint: agent.endpoint, executionId: executionHandle.executionId, taskId: result.taskId, enrollmentId: enrollment.id, scriptType, scriptId, scriptVersionId, timeoutMs: resolvedTimeoutMs, argumentNames: Object.keys(argumentValues), status: result.status, success: result.result?.success ?? null, exitCode: result.result?.exitCode ?? null }
      });
      const response = { executionId: executionHandle.executionId, taskId: result.taskId, status: result.status, scheduled: result.scheduled, endpoint: agent.endpoint, enrollmentId: enrollment.id, scriptType, scriptId, scriptVersionId, scriptName, version: scriptVersion, platform: scriptPlatform, language: scriptLanguage, ...(result.result ?? {}) };
      return result.scheduled ? reply.code(202).send(response) : response;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command agent execution failed";
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "tunnel.command_executed",
        entityType: "tunnel",
        entityId: id,
        details: { endpoint: agent.endpoint, executionId: executionHandle.executionId, enrollmentId: enrollment.id, scriptType, scriptId, scriptVersionId, timeoutMs: resolvedTimeoutMs, success: false, error: message }
      });
      return reply.code(502).send({ error: message, executionId: executionHandle.executionId });
    }
  });

  app.post("/api/tunnels/:id/execution-variables/resolve", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = resolveExecutionVariablesSchema.parse(request.body);
    let argumentsList: ScriptArgument[] = [];
    if (body.scriptVersionId) {
      const result = await pool.query(
        `SELECT v.arguments FROM managed_script_versions v WHERE v.id = $1`,
        [body.scriptVersionId]
      );
      if (!result.rowCount) return reply.code(404).send({ error: "Script version not found" });
      argumentsList = scriptArgumentsSchema.parse(result.rows[0].arguments);
    }
    try {
      const available = await resolveAvailableVariablesForTunnel(id);
      return { arguments: argumentsList, availableVariables: available.variables, sources: available.sources };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resolve available variables";
      return reply.code(message === "Tunnel not found" ? 404 : 409).send({ error: message });
    }
  });

  app.put("/api/tunnels/:id/execution-variables", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ variables: executionVariablesSchema }).parse(request.body);
    const result = await pool.query(
      "UPDATE tunnels SET execution_variables = $1, updated_at = now() WHERE id = $2 RETURNING display_name",
      [body.variables, id]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Tunnel not found" });
    await writeAudit({ actorUserId: request.authUser!.id, action: "tunnel.execution_variables_updated", entityType: "tunnel", entityId: id, details: { variableNames: Object.keys(body.variables) } });
    return { variables: body.variables };
  });

  app.put("/api/tunnels/:tunnelId/enrollments/:enrollmentId/execution-variables", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, enrollmentId } = z.object({ tunnelId: z.string().uuid(), enrollmentId: z.string().uuid() }).parse(request.params);
    const body = z.object({ variables: executionVariablesSchema }).parse(request.body);
    const result = await pool.query(
      `UPDATE enrollments
          SET execution_variables = $1, updated_at = now()
        WHERE id = $2 AND tunnel_id = $3
        RETURNING NULLIF(host_info->>'machineName', '') AS "computerName"`,
      [body.variables, enrollmentId, tunnelId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Enrollment not found" });
    await writeAudit({ actorUserId: request.authUser!.id, action: "enrollment.execution_variables_updated", entityType: "enrollment", entityId: enrollmentId, details: { tunnelId, variableNames: Object.keys(body.variables) } });
    return { variables: body.variables };
  });

  app.post("/api/tunnels/:tunnelId/commands/executions/:executionId/save-script", { preHandler: requireAuth }, async (request, reply) => {
    const { tunnelId, executionId } = z.object({
      tunnelId: z.string().uuid(),
      executionId: z.string().uuid()
    }).parse(request.params);
    const body = saveInlineExecutionSchema.parse(request.body ?? {});
    const saved = await withTransaction(async (client) => {
      const executionResult = await client.query(
        `SELECT id, script_type, script_name, script_platform, script_language, script,
                saved_script_id, saved_script_version_id, inline_arguments
           FROM tunnel_command_executions
          WHERE id = $1 AND tunnel_id = $2
          FOR UPDATE`,
        [executionId, tunnelId]
      );
      const execution = executionResult.rows[0];
      if (!execution) return null;
      if (execution.saved_script_id && execution.saved_script_version_id) {
        return {
          executionId,
          scriptId: execution.saved_script_id as string,
          versionId: execution.saved_script_version_id as string,
          version: 1,
          alreadySaved: true
        };
      }
      if (execution.script_type !== "inline") return { error: "Only inline executions can be saved to the script library" } as const;
      if (!execution.script_platform || !execution.script_language) {
        return { error: "This inline execution does not contain enough platform metadata to create a saved script" } as const;
      }
      const name = body.name ?? execution.script_name ?? "Inline script";
      const script = await client.query(
        `INSERT INTO managed_scripts(name, platform, language, description, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [name, execution.script_platform, execution.script_language, `Saved from inline execution ${executionId}`, request.authUser!.id]
      );
      const version = await client.query(
        `INSERT INTO managed_script_versions(script_id, version, content, arguments, created_by)
         VALUES ($1, 1, $2, $3, $4)
         RETURNING id, version`,
        [script.rows[0].id, execution.script, JSON.stringify(execution.inline_arguments), request.authUser!.id]
      );
      await client.query(
        `UPDATE tunnel_command_executions
            SET script_type = 'managed', script_version_id = $2, script_version_number = 1,
                saved_script_id = $1, saved_script_version_id = $2, saved_at = now()
          WHERE id = $3`,
        [script.rows[0].id, version.rows[0].id, executionId]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "tunnel.inline_execution_saved",
        entityType: "tunnel_command_execution",
        entityId: executionId,
        details: { tunnelId, scriptId: script.rows[0].id, scriptVersionId: version.rows[0].id, name }
      }, client);
      return {
        executionId,
        scriptId: script.rows[0].id as string,
        versionId: version.rows[0].id as string,
        version: version.rows[0].version as number,
        alreadySaved: false
      };
    });
    if (!saved) return reply.code(404).send({ error: "Command execution not found" });
    if ("error" in saved) return reply.code(409).send({ error: saved.error });
    return reply.code(saved.alreadySaved ? 200 : 201).send(saved);
  });

  app.post("/api/tunnels", { preHandler: requireAuth }, async (request, reply) => {
    const body = createTunnelSchema.parse(request.body);
    const publicHostname = await cloudflareManPublicHostname();
    let tunnelId: string;
    try {
      tunnelId = await withTransaction(async (client) => {
      const allocation = await selectZone(client, body.zoneId);
      const publications = body.publications ?? [{ suffix: "", routes: [{ kind: "service" as const, path: "/", serviceUrl: body.originUrl! }] }];
      const prepared = body.publications
        ? preparePublications(body.tunnelCode, allocation.zoneName, publications)
        : publications.map((publication) => ({ ...publication, hostname: `${slugifyLabel(`${body.tenantCode}-${body.tunnelCode}`)}.${allocation.zoneName}` }));
      const primary = prepared[0];
      if (!primary) throw new Error("At least one published endpoint is required");
      const primaryRoute = primary.routes.find((route) => route.path === "/") ?? primary.routes[0];
      if (!primaryRoute) throw new Error("The primary published endpoint requires at least one route");
      const result = await client.query(
        `INSERT INTO tunnels(tenant_code, tunnel_code, display_name, origin_url, account_id, zone_id, hostname)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_code AS "tenantCode", tunnel_code AS "tunnelCode", display_name AS "displayName", hostname`,
        [body.tenantCode, body.tunnelCode, body.displayName, primaryRoute.serviceUrl, allocation.accountId, allocation.zoneId, primary.hostname]
      );
      for (const publication of prepared) {
        const inserted = await client.query(
          `INSERT INTO tunnel_publications(tunnel_id, suffix, custom_label, hostname)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [result.rows[0].id, publication.suffix, publication.customLabel ?? null, publication.hostname]
        );
        for (const [index, route] of publication.routes.entries()) {
          await client.query(
            `INSERT INTO tunnel_routes(publication_id, path, service_url, route_kind, sort_order, waf_enabled)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [inserted.rows[0].id, route.path, route.serviceUrl, route.kind ?? "service", index, route.kind === "command_agent" ? true : !isCloudflareManPublicHostname(publication.hostname, publicHostname)]
          );
        }
      }
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "tunnel.created",
        entityType: "tunnel",
        entityId: result.rows[0].id,
        details: {
          hostnames: prepared.map((publication) => publication.hostname),
          routeCount: prepared.reduce((total, publication) => total + publication.routes.length, 0),
          accountId: allocation.accountId,
          zoneId: allocation.zoneId
        }
      }, client);
      return result.rows[0].id as string;
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "A tunnel with this hostname already exists in this zone" });
      }
      throw error;
    }
    await ensureCloudflareManRemoteAgentRoutes(publicHostname);
    const created = await pool.query(`
      SELECT s.id, s.tenant_code AS "tenantCode", s.tunnel_code AS "tunnelCode", s.display_name AS "displayName", s.execution_variables AS "executionVariables",
             s.origin_url AS "originUrl", s.hostname, s.cf_tunnel_id AS "cfTunnelId", s.cf_tunnel_name AS "cfTunnelName",
             s.cf_tunnel_status AS "cfTunnelStatus", s.onboarding_status AS "onboardingStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.ssh_status AS "sshStatus", s.ssh_target_ip::text AS "sshTargetIp", s.ssh_port AS "sshPort",
             s.ssh_username AS "sshUsername", s.ssh_url AS "sshUrl", s.ssh_last_error AS "sshLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.waf_warning AS "wafWarning",
             s.created_at AS "createdAt", a.id AS "accountId", a.cf_account_id AS "cfAccountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications,
             ${commandAgentJson} AS "commandAgent"
        FROM tunnels s JOIN cloudflare_accounts a ON a.id = s.account_id JOIN zones z ON z.id = s.zone_id
       WHERE s.id = $1
    `, [tunnelId]);
    return reply.code(201).send({ tunnel: created.rows[0] });
  });

  app.patch("/api/tunnels/:id/zone", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ zoneId: z.string().uuid() }).parse(request.body);
    const publicHostname = await cloudflareManPublicHostname();
    try {
      const result = await withTransaction(async (client) => {
        const tunnelResult = await client.query(
          `SELECT s.id, s.tenant_code, s.tunnel_code, s.zone_id, s.cf_tunnel_id,
                  NOT EXISTS (
                    SELECT 1 FROM enrollments e
                     WHERE e.tunnel_id = s.id AND e.status IN ('ready', 'installed')
                       AND e.unenrolled_at IS NULL AND e.deleted_at IS NULL
                  ) AS "noActiveEnrollment"
             FROM tunnels s WHERE s.id = $1 FOR UPDATE`,
          [id]
        );
        const tunnel = tunnelResult.rows[0];
        if (!tunnel) return { kind: "missing" as const };
        if (tunnel.cf_tunnel_id || !tunnel.noActiveEnrollment) return { kind: "blocked" as const };
        if (tunnel.zone_id === body.zoneId) return { kind: "same_zone" as const };

        const allocation = await selectZone(client, body.zoneId);
        const publications = await client.query(
          "SELECT id, suffix, custom_label FROM tunnel_publications WHERE tunnel_id = $1 ORDER BY created_at",
          [id]
        );
        const baseLabel = slugifyLabel(`${tunnel.tenant_code}-${tunnel.tunnel_code}`);
        const prepared = publications.rows.map((publication) => ({
          id: publication.id as string,
          hostname: `${publication.custom_label || (publication.suffix ? `${baseLabel}-${publication.suffix}` : baseLabel)}.${allocation.zoneName}`
        }));
        const primary = prepared[0];
        if (!primary) throw new Error("Tunnel has no published endpoints");

        await client.query(
          "UPDATE tunnels SET account_id = $1, zone_id = $2, hostname = $3, updated_at = now() WHERE id = $4",
          [allocation.accountId, allocation.zoneId, primary.hostname, id]
        );
        for (const publication of prepared) {
          await client.query(
            "UPDATE tunnel_publications SET hostname = $1, updated_at = now() WHERE id = $2",
            [publication.hostname, publication.id]
          );
          if (isCloudflareManPublicHostname(publication.hostname, publicHostname)) {
            await client.query("UPDATE tunnel_routes SET waf_enabled = false, updated_at = now() WHERE publication_id = $1", [publication.id]);
          }
        }
        // Defensive: a fully deprovisioned tunnel should already have these
        // cleared, but a zone-scoped WAF ruleset reference from the old zone
        // would 404 if reused, so make sure none linger.
        await client.query(
          `UPDATE tunnel_routes r SET waf_ruleset_id = null, waf_rule_id = null, updated_at = now()
             FROM tunnel_publications p WHERE r.publication_id = p.id AND p.tunnel_id = $1`,
          [id]
        );
        await writeAudit({
          actorUserId: request.authUser!.id,
          action: "tunnel.zone_reassigned",
          entityType: "tunnel",
          entityId: id,
          details: { fromZoneId: tunnel.zone_id, toZoneId: allocation.zoneId, hostnames: prepared.map((publication) => publication.hostname) }
        }, client);
        return { kind: "ok" as const };
      });
      if (result.kind === "missing") return reply.code(404).send({ error: "Tunnel not found" });
      if (result.kind === "blocked") return reply.code(409).send({ error: "The tunnel must have no active enrollment and be fully unenrolled before its account/zone can be changed" });
      if (result.kind === "same_zone") return reply.code(409).send({ error: "Tunnel is already assigned to this zone" });
      await ensureCloudflareManRemoteAgentRoutes(publicHostname);
      return { success: true };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "A tunnel with this hostname already exists in the target zone" });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Unable to change account/zone" });
    }
  });

  app.put("/api/tunnels/:id/connectivity", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = connectivitySchema.parse(request.body);
    const publicHostname = await cloudflareManPublicHostname();
    const runUpdate = () => withTransaction(async (client) => {
      const tunnelResult = await client.query(
        `SELECT s.id, s.tunnel_code, s.cf_tunnel_id, z.name AS zone_name
           FROM tunnels s JOIN zones z ON z.id = s.zone_id
          WHERE s.id = $1
          FOR UPDATE OF s`,
        [id]
      );
      const tunnel = tunnelResult.rows[0];
      if (!tunnel) return null;

      const existingResult = await client.query(
        `SELECT p.hostname, p.dns_record_id,
                r.path, r.waf_enabled, r.waf_allowed_ips, r.waf_ruleset_id, r.waf_rule_id
           FROM tunnel_publications p
           LEFT JOIN tunnel_routes r ON r.publication_id = p.id
          WHERE p.tunnel_id = $1
          ORDER BY p.created_at, r.sort_order, r.created_at`,
        [id]
      );
      const existingByHostname = new Map<string, { dnsRecordId: string | null }>(
        existingResult.rows.filter((publication) => publication.dns_record_id || publication.path === null).map((publication) => [publication.hostname, { dnsRecordId: publication.dns_record_id }])
      );
      const existingWafByRoute = new Map<string, { enabled: boolean; allowedIps: string[]; rulesetId: string | null; ruleId: string | null }>(
        existingResult.rows.filter((route) => route.path !== null).map((route) => [`${route.hostname}${route.path}`, {
          enabled: route.waf_enabled,
          allowedIps: route.waf_allowed_ips ?? [],
          rulesetId: route.waf_ruleset_id,
          ruleId: route.waf_rule_id
        }])
      );
      const prepared = preparePublications(tunnel.tunnel_code, tunnel.zone_name, body.publications);
      const desiredHostnames = new Set(prepared.map((publication) => publication.hostname));
      const removedDnsRecordIds = [...new Set<string>(existingResult.rows
        .filter((publication) => publication.dns_record_id && !desiredHostnames.has(publication.hostname))
        .map((publication) => publication.dns_record_id as string))];

      await client.query("DELETE FROM tunnel_publications WHERE tunnel_id = $1", [id]);
      for (const publication of prepared) {
        const existing = existingByHostname.get(publication.hostname);
        const inserted = await client.query(
          `INSERT INTO tunnel_publications(tunnel_id, suffix, custom_label, hostname, dns_record_id, status)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [id, publication.suffix, publication.customLabel ?? null, publication.hostname, existing?.dnsRecordId ?? null, existing?.dnsRecordId ? "active" : "pending"]
        );
        for (const [index, route] of publication.routes.entries()) {
          const waf = existingWafByRoute.get(`${publication.hostname}${route.path}`);
          const wafEnabled = route.kind === "command_agent"
            ? true
            : isCloudflareManPublicHostname(publication.hostname, publicHostname) ? false : (waf?.enabled ?? true);
          await client.query(
            `INSERT INTO tunnel_routes(publication_id, path, service_url, route_kind, sort_order, waf_enabled, waf_allowed_ips, waf_ruleset_id, waf_rule_id)
             VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, ARRAY[]::text[]), $8, $9)`,
            [inserted.rows[0].id, route.path, route.serviceUrl, route.kind, index, wafEnabled, waf?.allowedIps ?? null, waf?.rulesetId ?? null, waf?.ruleId ?? null]
          );
        }
      }
      const primary = prepared[0];
      if (!primary) throw new Error("At least one published endpoint is required");
      const primaryRoute = primary.routes.find((route) => route.path === "/") ?? primary.routes[0];
      if (!primaryRoute) throw new Error("The primary published endpoint requires at least one route");
      await client.query(
        "UPDATE tunnels SET hostname = $1, origin_url = $2, dns_record_id = $3, last_error = null, updated_at = now() WHERE id = $4",
        [primary.hostname, primaryRoute.serviceUrl, existingByHostname.get(primary.hostname)?.dnsRecordId ?? null, id]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "tunnel.connectivity_updated",
        entityType: "tunnel",
        entityId: id,
        details: {
          hostnames: prepared.map((publication) => publication.hostname),
          routeCount: prepared.reduce((total, publication) => total + publication.routes.length, 0),
          removedHostnameCount: new Set(existingResult.rows.filter((publication) => !desiredHostnames.has(publication.hostname)).map((publication) => publication.hostname)).size
        }
      }, client);
      return { cfTunnelId: tunnel.cf_tunnel_id as string | null, removedDnsRecordIds };
    });
    let update: Awaited<ReturnType<typeof runUpdate>>;
    try {
      update = await runUpdate();
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "A tunnel with this hostname already exists in this zone" });
      }
      throw error;
    }
    if (!update) return reply.code(404).send({ error: "Tunnel not found" });
    await ensureCloudflareManRemoteAgentRoutes(publicHostname);

    try {
      const applied = update.cfTunnelId ? await reconfigureTunnel(id, update.removedDnsRecordIds) : false;
      if (applied) await syncBrowserSsh(id).catch(() => undefined);
      return { success: true, applied };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connectivity update failed";
      return reply.code(502).send({ error: message });
    }
  });

  app.post("/api/tunnels/:id/enrollments", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = enrollmentSchema.parse(request.body ?? {});
    const rawToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);
    const issued = await withTransaction(async (client) => {
      const tunnel = await client.query("SELECT id FROM tunnels WHERE id = $1 FOR UPDATE", [id]);
      if (!tunnel.rowCount) throw new Error("Tunnel not found");
      await ensureCommandAgentToken(client, id);
      // Claiming this new link auto-unenrolls any other active enrollment for
      // this tunnel server-side (see reconcilePriorEnrollments in enrollment.ts),
      // so we only need to flag the transitional state here, not pre-issue
      // cleanup scripts for the operator to run manually.
      const active = await client.query(
        `SELECT id, platform, created_at
           FROM enrollments
          WHERE tunnel_id = $1
            AND status IN ('claimed', 'provisioning', 'ready', 'installed')
            AND unenrolled_at IS NULL
            AND deleted_at IS NULL
          ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC`,
        [id]
      );
      const hasActivePrevious = (active.rowCount ?? 0) > 0;
      await client.query(
        "UPDATE enrollments SET status = 'revoked', updated_at = now() WHERE tunnel_id = $1 AND status IN ('url_issued', 'claimed', 'failed')",
        [id]
      );
      const result = await client.query(
        `INSERT INTO enrollments(tunnel_id, token_hash, token_encrypted, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [id, hashToken(rawToken), encryptSecret(rawToken), expiresAt, request.authUser!.id]
      );
      await client.query(
        `INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status)
         VALUES ($1, 'install', 'windows', 'available'), ($1, 'install', 'unix', 'available')`,
        [result.rows[0].id]
      );
      const unenrollCommands: Array<{ enrollmentId: string; createdAt: string; token: string }> = [];
      for (const previous of active.rows) {
        const unenrollToken = createOpaqueToken();
        await client.query(
          `UPDATE enrollments
              SET unenroll_token_hash = $1, unenroll_token_encrypted = $2,
                  unenroll_token_expires_at = $3, unenroll_cf_tunnel_id = (SELECT cf_tunnel_id FROM tunnels WHERE id = $4),
                  unenroll_requested_at = now(), unenroll_last_error = null,
                  superseded_by_enrollment_id = $5, updated_at = now()
            WHERE id = $6`,
          [hashToken(unenrollToken), encryptSecret(unenrollToken), expiresAt, id, result.rows[0].id, previous.id]
        );
        await client.query(
          `INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status)
           VALUES ($1, 'unenroll', 'windows', 'available'), ($1, 'unenroll', 'unix', 'available')
           ON CONFLICT (enrollment_id, script_kind, platform) DO UPDATE SET
             status = 'available', started_at = null, finished_at = null, last_error = null, updated_at = now()`,
          [previous.id]
        );
        unenrollCommands.push({ enrollmentId: previous.id, createdAt: previous.created_at, token: unenrollToken });
      }
      await client.query(
        "UPDATE tunnels SET onboarding_status = $1, last_error = null, updated_at = now() WHERE id = $2",
        [hasActivePrevious ? "waiting_for_new_enrollment" : "url_issued", id]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.issued",
        entityType: "tunnel",
        entityId: id,
        details: { enrollmentId: result.rows[0].id, expiresAt, hasActivePrevious }
      }, client);
      return { id: result.rows[0].id as string, unenrollCommands };
    });
    const unenrollCommands = await Promise.all(issued.unenrollCommands.map(async (command) => ({
      enrollmentId: command.enrollmentId,
      createdAt: command.createdAt,
      expiresAt,
      urls: await unenrollmentUrls(command.token)
    })));
    return reply.code(201).send({
      id: issued.id,
      expiresAt,
      urls: await enrollmentUrls(rawToken),
      unenrollCommands
    });
  });

  app.post("/api/tunnels/:id/enrollments/revoke", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const revoked = await withTransaction(async (client) => {
      const tunnel = await client.query("SELECT id, onboarding_status FROM tunnels WHERE id = $1 FOR UPDATE", [id]);
      if (!tunnel.rowCount) return null;
      const result = await client.query(
        `UPDATE enrollments SET status = 'revoked', updated_at = now()
            WHERE tunnel_id = $1 AND status IN ('url_issued', 'claimed', 'provisioning', 'ready', 'failed')
          RETURNING id`,
        [id]
      );
      if (["url_issued", "claimed", "provisioning", "failed"].includes(tunnel.rows[0].onboarding_status)) {
        await client.query("UPDATE tunnels SET onboarding_status = 'revoked', updated_at = now() WHERE id = $1", [id]);
      }
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.revoked",
        entityType: "tunnel",
        entityId: id,
        details: { enrollmentCount: result.rowCount }
      }, client);
      return result.rowCount;
    });
    if (revoked === null) return reply.code(404).send({ error: "Tunnel not found" });
    return { success: true, revoked };
  });

  app.post("/api/tunnels/:id/verify", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ publicationId: z.string().uuid().optional(), routeId: z.string().uuid().optional() }).parse(request.body ?? {});
    const tunnelAccount = await pool.query("SELECT account_id FROM tunnels WHERE id = $1", [id]);
    if (tunnelAccount.rows[0]?.account_id) {
      await synchronizeAccount(tunnelAccount.rows[0].account_id as string).catch(() => undefined);
    }
    const result = await verifyTunnelEndpoints(id, {
      actorUserId: request.authUser!.id,
      ...(body.publicationId ? { publicationId: body.publicationId } : {}),
      ...(body.routeId ? { routeId: body.routeId } : {})
    });
    if (!result) return reply.code(404).send({ error: body.routeId ? "Ingress route not found" : body.publicationId ? "Published endpoint not found" : "Tunnel not found" });
    return result;
  });

  app.post("/api/tunnels/refresh", { preHandler: requireAuth }, async (request) => {
    const body = refreshTunnelsSchema.parse(request.body);
    const accountIds = await pool.query(
      "SELECT DISTINCT account_id FROM tunnels WHERE id = ANY($1::uuid[]) AND account_id IS NOT NULL",
      [body.tunnelIds]
    );
    // Tunnel status (online/offline) only ever comes from Cloudflare's own tunnel
    // list, never from the endpoint reachability checks below.
    await Promise.all(accountIds.rows.map((row) => synchronizeAccount(row.account_id as string).catch(() => undefined)));
    const results: Array<{ tunnelId: string; success: boolean; error?: string }> = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < body.tunnelIds.length) {
        const tunnelId = body.tunnelIds[nextIndex++]!;
        try {
          const result = await verifyTunnelEndpoints(tunnelId, {
            actorUserId: request.authUser!.id,
            attempts: 2,
            retryDelayMs: 1_000
          });
          results.push({ tunnelId, success: result?.success ?? false, ...(!result ? { error: "Tunnel not found" } : {}) });
        } catch (error) {
          results.push({
            tunnelId,
            success: false,
            error: error instanceof Error ? error.message : "Tunnel refresh failed"
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, body.tunnelIds.length) }, () => worker()));
    const refreshed = results.filter((result) => result.success).length;
    return { success: refreshed === results.length, refreshed, failed: results.length - refreshed, results };
  });

  app.post("/api/tunnels/:id/rdp/retry", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const tunnel = await pool.query("SELECT id, rdp_target_ip FROM tunnels WHERE id = $1", [id]);
    if (!tunnel.rowCount) return reply.code(404).send({ error: "Tunnel not found" });
    if (!tunnel.rows[0].rdp_target_ip) {
      return reply.code(409).send({ error: "Remote Desktop has not been enabled on this machine yet - use Enable RDS" });
    }
    const result = await provisionBrowserRdp(id);
    if (!result.ready) return reply.code(502).send({ error: result.error ?? "RDP provisioning failed" });
    return result;
  });

  // Runs the registry/firewall/service logic that used to be baked into the
  // Windows install script, but now on demand: sends it as a remote command
  // through the machine's already-installed command agent, then (once the
  // agent answers, whether immediately or via the async report callback -
  // see completeRdpEnableExecution) provisions the browser-RDP gateway with
  // whatever target IP it discovers.
  app.post("/api/tunnels/:id/rdp/enable", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const enrollmentResult = await pool.query(
      `SELECT id, platform
         FROM enrollments
        WHERE tunnel_id = $1
          AND status IN ('ready', 'installed')
          AND unenrolled_at IS NULL
          AND deleted_at IS NULL
        ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC
        LIMIT 1`,
      [id]
    );
    const enrollment = enrollmentResult.rows[0];
    if (!enrollment) return reply.code(409).send({ error: "This tunnel has no active enrollment" });
    if (enrollment.platform !== "windows") return reply.code(409).send({ error: "Remote Desktop only applies to Windows enrollments" });
    const agent = await getCommandAgentConfig(id);
    if (!agent) return reply.code(409).send({ error: "No command agent route is configured for this tunnel" });
    await pool.query(
      "UPDATE tunnels SET rdp_status = 'provisioning', rdp_last_error = null, updated_at = now() WHERE id = $1",
      [id]
    );
    const script = rdpEnableScript();
    const executionHandle = await createCommandExecution({
      tunnelId: id,
      enrollmentId: enrollment.id,
      scriptVersionId: null,
      requestedBy: request.authUser!.id,
      script,
      timeoutMs: 30_000,
      scriptType: "inline",
      scriptName: RDP_ENABLE_SCRIPT_MARKER,
      scriptPlatform: "windows",
      scriptLanguage: "powershell",
      scriptVersion: null
    });
    try {
      const dispatch = await executeTunnelScript(id, script, 30_000, executionHandle);
      if (!dispatch) return reply.code(409).send({ error: "No command agent route is configured for this tunnel" });
      if (dispatch.scheduled) return reply.code(202).send({ scheduled: true, executionId: executionHandle.executionId });
      const result = await completeRdpEnableExecution(id, dispatch.result?.stdout ?? "");
      if (!result.ready) return reply.code(502).send({ error: result.error ?? "RDP provisioning failed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command agent execution failed";
      return reply.code(502).send({ error: message, executionId: executionHandle.executionId });
    }
  });

  app.post("/api/tunnels/:id/ssh/retry", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const tunnel = await pool.query("SELECT id FROM tunnels WHERE id = $1", [id]);
    if (!tunnel.rowCount) return reply.code(404).send({ error: "Tunnel not found" });
    const result = await provisionBrowserSsh(id);
    if (!result.ready) return reply.code(502).send({ error: result.error ?? "SSH provisioning failed" });
    return result;
  });

  app.post("/api/tunnels/:id/diagnose", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const enrollment = await pool.query(
      `SELECT id, platform FROM enrollments
        WHERE tunnel_id = $1 AND deleted_at IS NULL AND unenrolled_at IS NULL
        ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC LIMIT 1`,
      [id]
    );
    if (!enrollment.rowCount) return reply.code(404).send({ error: "No enrollment found for this tunnel" });
    const rawToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const diagnosticRun = await pool.query(
      `INSERT INTO enrollment_diagnostic_runs(enrollment_id, token_hash, platform, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, status`,
      [enrollment.rows[0].id, hashToken(rawToken), enrollment.rows[0].platform, expiresAt]
    );
    const baseUrl = await getPublicBaseUrl();
    return {
      enrollmentId: enrollment.rows[0].id,
      diagnosticRunId: diagnosticRun.rows[0].id,
      status: diagnosticRun.rows[0].status,
      platform: enrollment.rows[0].platform,
      expiresAt: expiresAt.toISOString(),
      urls: {
        shell: `${baseUrl}/d/${rawToken}/diagnose.sh`,
        powershell: `${baseUrl}/d/${rawToken}/diagnose.ps1`
      }
    };
  });
}
