import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createCommandExecution, executeTunnelScript, getCommandAgentConfig } from "../lib/command-agent.js";
import { pool, withTransaction } from "../lib/database.js";
import { appendNameFilter, nameFilterFields, validateNameFilter } from "../lib/name-filter.js";
import { argumentBindingsSchema, applyScriptArguments, describeArgumentValueSources, resolveArgumentValues, resolveAvailableVariablesForTunnels, scriptArgumentsSchema } from "../lib/execution-variables.js";
import { latestEnrollmentJoin, onboardingStatusExpression } from "./tunnels.js";

const platformSchema = z.enum(["windows", "unix"]);
const languageSchema = z.enum(["powershell", "bash", "sh"]);
const scriptContent = z.string().min(1).max(262_144).refine((value) => value.trim().length > 0, "Script content is required");
const scriptMetadata = z.object({
  name: z.string().trim().min(1).max(120),
  platform: platformSchema,
  language: languageSchema,
  description: z.string().trim().max(500).default(""),
  defaultTimeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  arguments: scriptArgumentsSchema.default([])
});
const scriptCreateSchema = scriptMetadata.extend({ content: scriptContent });
const scriptUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  language: languageSchema.optional(),
  description: z.string().trim().max(500).optional(),
  defaultTimeoutMs: z.number().int().min(1_000).max(300_000).optional()
});
const versionSchema = z.object({ content: scriptContent, arguments: scriptArgumentsSchema.default([]) });
const executionTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/, "Timestamp must use ISO 8601 format");
const executionHistorySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
  search: z.string().trim().max(120).optional(),
  from: executionTimestampSchema.optional(),
  to: executionTimestampSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10)
});
const bulkFilterSchema = z.object({
  ...nameFilterFields,
  tenantCode: z.string().trim().max(80).optional(),
  cfTunnelStatus: z.string().trim().max(40).optional(),
  enrollmentStatus: z.string().trim().max(40).optional()
}).superRefine(validateNameFilter);
const bulkExecuteSchema = z.object({
  scriptVersionId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).default(""),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  tunnelIds: z.array(z.string().uuid()).max(5000).optional(),
  excludeTunnelIds: z.array(z.string().uuid()).max(5000).optional(),
  filters: bulkFilterSchema.default({ nameMatch: "ilike" }),
  selectAll: z.boolean().default(false),
  argumentBindings: argumentBindingsSchema.default({})
}).superRefine((value, context) => {
  if (!value.selectAll && !value.tunnelIds?.length) {
    context.addIssue({ code: "custom", path: ["tunnelIds"], message: "Select tunnels or provide filters before starting a bulk execution" });
  }
});
const scriptListQuerySchema = z.object({
  ...nameFilterFields,
  platform: platformSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(100)
}).superRefine(validateNameFilter);

function validateLanguage(platform: "windows" | "unix", language: "powershell" | "bash" | "sh"): string | null {
  if (platform === "windows" && language !== "powershell") return "Windows scripts must use PowerShell";
  if (platform === "unix" && language === "powershell") return "Unix scripts must use Bash or sh";
  return null;
}

const scriptSummary = `jsonb_build_object(
  'id', s.id,
  'name', s.name,
  'platform', s.platform,
  'language', s.language,
  'description', s.description,
  'defaultTimeoutMs', s.default_timeout_ms,
  'latestVersion', latest.version,
  'latestVersionId', latest.id,
  'versionCount', COALESCE(latest."versionCount", 0),
  'executionStats', jsonb_build_object(
    'total', execution_stats.total,
    'succeeded', execution_stats.succeeded,
    'failed', execution_stats.failed,
    'timedOut', execution_stats."timedOut",
    'cancelled', execution_stats.cancelled,
    'scheduled', execution_stats.scheduled,
    'running', execution_stats.running
  ),
  'updatedAt', s.updated_at,
  'createdAt', s.created_at
)`;

export async function scriptRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/scripts", { preHandler: requireAuth }, async (request) => {
    const query = scriptListQuerySchema.parse(request.query);
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.platform) {
      values.push(query.platform);
      conditions.push(`s.platform = $${values.length}`);
    }
    appendNameFilter(conditions, values, "s.name", query);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (query.page - 1) * query.pageSize;
    const pageValues = [...values, query.pageSize, offset];
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT ${scriptSummary} AS script
         FROM managed_scripts s
         LEFT JOIN LATERAL (
           SELECT v.id, v.version, count(*) OVER()::int AS "versionCount"
             FROM managed_script_versions v
            WHERE v.script_id = s.id
            ORDER BY v.version DESC
           LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS total,
                  (count(*) FILTER (WHERE ce.status = 'succeeded'))::int AS succeeded,
                  (count(*) FILTER (WHERE ce.status = 'failed'))::int AS failed,
                  (count(*) FILTER (WHERE ce.status = 'timed_out'))::int AS "timedOut",
                  (count(*) FILTER (WHERE ce.status = 'cancelled'))::int AS cancelled,
                  (count(*) FILTER (WHERE ce.status = 'scheduled'))::int AS scheduled,
                  (count(*) FILTER (WHERE ce.status = 'running'))::int AS running
             FROM tunnel_command_executions ce
             LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
             LEFT JOIN managed_script_versions saved_version ON saved_version.id = ce.saved_script_version_id
            WHERE executed_version.script_id = s.id OR saved_version.script_id = s.id
         ) execution_stats ON true
        ${where}
        ORDER BY s.name, s.platform
        LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        pageValues
      ),
      pool.query(
        `SELECT count(*)::int AS total
           FROM managed_scripts s
          ${where}`,
        values
      )
    ]);
    const total = countResult.rows[0].total as number;
    return {
      scripts: result.rows.map((row) => row.script),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize))
      }
    };
  });

  app.get("/api/scripts/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [summaryResult, versionsResult] = await Promise.all([
      pool.query(
        `SELECT ${scriptSummary} AS script
           FROM managed_scripts s
           LEFT JOIN LATERAL (
             SELECT v.id, v.version, count(*) OVER()::int AS "versionCount"
               FROM managed_script_versions v
              WHERE v.script_id = s.id
              ORDER BY v.version DESC
             LIMIT 1
           ) latest ON true
           LEFT JOIN LATERAL (
             SELECT count(*)::int AS total,
                    (count(*) FILTER (WHERE ce.status = 'succeeded'))::int AS succeeded,
                    (count(*) FILTER (WHERE ce.status = 'failed'))::int AS failed,
                    (count(*) FILTER (WHERE ce.status = 'timed_out'))::int AS "timedOut",
                    (count(*) FILTER (WHERE ce.status = 'cancelled'))::int AS cancelled,
                    (count(*) FILTER (WHERE ce.status = 'scheduled'))::int AS scheduled,
                    (count(*) FILTER (WHERE ce.status = 'running'))::int AS running
               FROM tunnel_command_executions ce
               LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
               LEFT JOIN managed_script_versions saved_version ON saved_version.id = ce.saved_script_version_id
              WHERE executed_version.script_id = s.id OR saved_version.script_id = s.id
           ) execution_stats ON true
          WHERE s.id = $1`,
        [id]
      ),
      pool.query(
        `SELECT v.id, v.version, v.content, v.arguments, v.created_at AS "createdAt", u.username AS "createdBy"
           FROM managed_script_versions v
           LEFT JOIN users u ON u.id = v.created_by
          WHERE v.script_id = $1
          ORDER BY v.version DESC`,
        [id]
      )
    ]);
    if (!summaryResult.rowCount) return reply.code(404).send({ error: "Script not found" });
    return { script: { ...summaryResult.rows[0].script, versions: versionsResult.rows } };
  });

  app.get("/api/scripts/:id/executions", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = executionHistorySchema.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const script = await pool.query("SELECT 1 FROM managed_scripts WHERE id = $1", [id]);
    if (!script.rowCount) return reply.code(404).send({ error: "Script not found" });
    const values: unknown[] = [id, query.version ?? null];
    const joins = `
      FROM tunnel_command_executions ce
      JOIN tunnels st ON st.id = ce.tunnel_id
      LEFT JOIN enrollments e ON e.id = ce.enrollment_id
      LEFT JOIN users u ON u.id = ce.requested_by
      LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
      LEFT JOIN managed_script_versions saved_version ON saved_version.id = ce.saved_script_version_id
      LEFT JOIN managed_scripts executed_script ON executed_script.id = executed_version.script_id
      LEFT JOIN managed_scripts saved_script ON saved_script.id = saved_version.script_id
     WHERE (executed_version.script_id = $1 OR saved_version.script_id = $1)
       AND ce.bulk_execution_id IS NULL
       AND ($2::int IS NULL OR COALESCE(executed_version.version, saved_version.version) = $2)`;
    const filters: string[] = [];
    if (query.search) {
      values.push(query.search);
      filters.push(`strpos(lower(concat_ws(' ', ce.script_name, executed_script.name, executed_script.description, saved_script.name, saved_script.description, st.display_name, st.tenant_code, st.tunnel_code, u.username)), lower($${values.length})) > 0`);
    }
    if (query.from) {
      values.push(query.from);
      filters.push(`ce.created_at >= $${values.length}::timestamptz`);
    }
    if (query.to) {
      values.push(query.to);
      filters.push(`ce.created_at <= $${values.length}::timestamptz`);
    }
    const where = filters.length ? ` AND ${filters.join(" AND ")}` : "";
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const [executionResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT ce.id,
                ce.tunnel_id AS "tunnelId", st.display_name AS "tunnelDisplayName",
                st.tenant_code AS "tenantCode", st.tunnel_code AS "tunnelCode",
                ce.enrollment_id AS "enrollmentId",
                NULLIF(e.host_info->>'machineName', '') AS "computerName",
                NULLIF(e.host_info->>'osName', '') AS "osName",
                e.platform AS environment, e.platform AS "enrollmentPlatform",
                ce.script_type AS "scriptType",
                $1::uuid AS "scriptId",
                ce.script_version_id AS "scriptVersionId",
                ce.saved_script_id AS "savedScriptId",
                ce.saved_script_version_id AS "savedScriptVersionId",
                ce.saved_at AS "savedAt",
                ce.bulk_execution_id AS "bulkExecutionId",
                COALESCE(executed_version.id, saved_version.id) AS "anchorScriptVersionId",
                COALESCE(executed_version.version, saved_version.version) AS "scriptVersion",
                COALESCE(ce.script_name, 'Inline script') AS "scriptName",
                ce.script_platform AS platform, ce.script_language AS language,
                ce.script, ce.environment_variables AS "environmentVariables", ce.argument_sources AS "argumentSources", COALESCE(executed_version.arguments, ce.inline_arguments) AS "scriptArguments", ce.timeout_ms AS "timeoutMs", ce.status, ce.task_id AS "taskId", ce.process_id AS "processId",
                ce.created_at AS "createdAt", ce.started_at AS "startedAt", ce.finished_at AS "finishedAt",
                ce.elapsed_ms AS "elapsedMs", ce.exit_code AS "exitCode",
                ce.stdout, ce.stderr, ce.error, u.username AS "requestedBy"
         ${joins}
         ${where}
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
         ${joins}
         ${where}`,
        values
      )
    ]);
    const summary = statsResult.rows[0];
    const total = summary.total as number;
    return {
      scriptId: id,
      version: query.version ?? null,
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

  app.get("/api/scripts/:id/execution-history", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = executionHistorySchema.parse(request.query);
    const script = await pool.query("SELECT 1 FROM managed_scripts WHERE id = $1", [id]);
    if (!script.rowCount) return reply.code(404).send({ error: "Script not found" });
    const values: unknown[] = [id, query.version ?? null];
    const filters: string[] = [];
    let searchParameter: string | null = null;
    let fromParameter: string | null = null;
    let toParameter: string | null = null;
    if (query.search) {
      values.push(query.search);
      searchParameter = `$${values.length}`;
      filters.push(`strpos(lower(concat_ws(' ', ce.script_name, executed_script.name, executed_script.description, saved_script.name, saved_script.description, st.display_name, st.tenant_code, st.tunnel_code, u.username)), lower(${searchParameter})) > 0`);
    }
    if (query.from) {
      values.push(query.from);
      fromParameter = `$${values.length}`;
      filters.push(`ce.created_at >= ${fromParameter}::timestamptz`);
    }
    if (query.to) {
      values.push(query.to);
      toParameter = `$${values.length}`;
      filters.push(`ce.created_at <= ${toParameter}::timestamptz`);
    }
    const executionScope = `
      (executed_version.script_id = $1 OR saved_version.script_id = $1)
      AND ($2::int IS NULL OR COALESCE(executed_version.version, saved_version.version) = $2)
      ${filters.length ? `AND ${filters.join(" AND ")}` : ""}`;
    const regularWhere = `${executionScope} AND ce.bulk_execution_id IS NULL`;
    const bulkFilters: string[] = [];
    if (searchParameter) {
      bulkFilters.push(`(strpos(lower(concat_ws(' ', r.name, r.description, bulk_script.name, bulk_script.description, bulk_user.username)), lower(${searchParameter})) > 0 OR EXISTS (
        SELECT 1 FROM tunnel_command_executions search_ce
        JOIN tunnels search_tunnel ON search_tunnel.id = search_ce.tunnel_id
        WHERE search_ce.bulk_execution_id = r.id
          AND strpos(lower(concat_ws(' ', search_tunnel.display_name, search_tunnel.tenant_code, search_tunnel.tunnel_code)), lower(${searchParameter})) > 0
      ))`);
    }
    if (fromParameter) {
      bulkFilters.push(`r.created_at >= ${fromParameter}::timestamptz`);
    }
    if (toParameter) {
      bulkFilters.push(`r.created_at <= ${toParameter}::timestamptz`);
    }
    const bulkWhere = `r.saved_script_id = $1
      AND ($2::int IS NULL OR bulk_version.version = $2)
      ${bulkFilters.length ? `AND ${bulkFilters.join(" AND ")}` : ""}`;
    const historySource = `
      SELECT jsonb_build_object(
               'kind', 'execution',
               'execution', jsonb_build_object(
                 'id', ce.id,
                 'tunnelId', ce.tunnel_id,
                 'tunnelDisplayName', st.display_name,
                 'tenantCode', st.tenant_code,
                 'tunnelCode', st.tunnel_code,
                 'enrollmentId', ce.enrollment_id,
                 'computerName', NULLIF(e.host_info->>'machineName', ''),
                 'osName', NULLIF(e.host_info->>'osName', ''),
                 'environment', e.platform,
                 'enrollmentPlatform', e.platform,
                 'scriptType', ce.script_type,
                 'scriptId', $1::uuid,
                 'scriptVersionId', ce.script_version_id,
                 'savedScriptId', ce.saved_script_id,
                 'savedScriptVersionId', ce.saved_script_version_id,
                 'savedAt', ce.saved_at,
                 'bulkExecutionId', ce.bulk_execution_id,
                 'anchorScriptVersionId', COALESCE(executed_version.id, saved_version.id),
                 'scriptVersion', COALESCE(executed_version.version, saved_version.version),
                 'scriptName', COALESCE(ce.script_name, executed_script.name, saved_script.name, 'Inline script'),
                 'platform', ce.script_platform,
                 'language', ce.script_language,
                 'script', ce.script,
                 'environmentVariables', ce.environment_variables,
                 'argumentSources', ce.argument_sources,
                 'scriptArguments', COALESCE(executed_version.arguments, ce.inline_arguments),
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
                 'requestedBy', u.username
               )
             ) AS item,
             ce.created_at AS sort_at,
             ce.id AS sort_id
        FROM tunnel_command_executions ce
        JOIN tunnels st ON st.id = ce.tunnel_id
        LEFT JOIN enrollments e ON e.id = ce.enrollment_id
        LEFT JOIN users u ON u.id = ce.requested_by
        LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
        LEFT JOIN managed_script_versions saved_version ON saved_version.id = ce.saved_script_version_id
        LEFT JOIN managed_scripts executed_script ON executed_script.id = executed_version.script_id
        LEFT JOIN managed_scripts saved_script ON saved_script.id = saved_version.script_id
       WHERE ${regularWhere}
      UNION ALL
      SELECT jsonb_build_object(
               'kind', 'bulk',
               'run', jsonb_build_object(
                 'id', r.id,
                 'name', r.name,
                 'description', r.description,
                 'scriptVersionId', r.saved_script_version_id,
                 'timeoutMs', r.timeout_ms,
                 'createdAt', r.created_at,
                 'requestedBy', bulk_user.username,
                 'argumentBindings', r.argument_overrides,
                 'selectedCount', count(ce.id)::int,
                 'running', count(ce.id) FILTER (WHERE ce.status = 'running'),
                 'succeeded', count(ce.id) FILTER (WHERE ce.status = 'succeeded'),
                 'failed', count(ce.id) FILTER (WHERE ce.status = 'failed'),
                 'timedOut', count(ce.id) FILTER (WHERE ce.status = 'timed_out'),
                 'cancelled', count(ce.id) FILTER (WHERE ce.status = 'cancelled'),
                 'scheduled', count(ce.id) FILTER (WHERE ce.status = 'scheduled')
               )
             ) AS item,
             r.created_at AS sort_at,
             r.id AS sort_id
        FROM script_bulk_executions r
        JOIN managed_script_versions bulk_version ON bulk_version.id = r.saved_script_version_id
        LEFT JOIN managed_scripts bulk_script ON bulk_script.id = r.saved_script_id
        LEFT JOIN users bulk_user ON bulk_user.id = r.requested_by
        LEFT JOIN tunnel_command_executions ce ON ce.bulk_execution_id = r.id
       WHERE ${bulkWhere}
       GROUP BY r.id, bulk_version.version, bulk_script.name, bulk_script.description, bulk_user.username`;
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const [historyResult, countResult, statsResult] = await Promise.all([
      pool.query(`SELECT item FROM (${historySource}) history ORDER BY sort_at DESC, sort_id DESC LIMIT $${limitParameter} OFFSET $${offsetParameter}`, [...values, query.pageSize, (query.page - 1) * query.pageSize]),
      pool.query(`SELECT count(*)::int AS total FROM (${historySource}) history`, values),
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
           LEFT JOIN users u ON u.id = ce.requested_by
           LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
           LEFT JOIN managed_script_versions saved_version ON saved_version.id = ce.saved_script_version_id
           LEFT JOIN managed_scripts executed_script ON executed_script.id = executed_version.script_id
           LEFT JOIN managed_scripts saved_script ON saved_script.id = saved_version.script_id
          WHERE ${executionScope}`,
        values
      )
    ]);
    const total = countResult.rows[0]?.total as number ?? 0;
    return {
      scriptId: id,
      version: query.version ?? null,
      history: historyResult.rows.map((row) => row.item),
      summary: statsResult.rows[0],
      pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) }
    };
  });

  app.get("/api/scripts/:id/bulk-executions", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(50).default(10) }).parse(request.query);
    const script = await pool.query("SELECT 1 FROM managed_scripts WHERE id = $1", [id]);
    if (!script.rowCount) return reply.code(404).send({ error: "Script not found" });
    const offset = (query.page - 1) * query.pageSize;
    const [runsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT r.id, r.name, r.description,
                r.saved_script_version_id AS "scriptVersionId", r.timeout_ms AS "timeoutMs", r.argument_overrides AS "argumentBindings",
                r.created_at AS "createdAt", u.username AS "requestedBy",
                count(ce.id)::int AS "selectedCount",
                (count(ce.id) FILTER (WHERE ce.status = 'running'))::int AS running,
                (count(ce.id) FILTER (WHERE ce.status = 'succeeded'))::int AS succeeded,
                (count(ce.id) FILTER (WHERE ce.status = 'failed'))::int AS failed,
                (count(ce.id) FILTER (WHERE ce.status = 'timed_out'))::int AS "timedOut",
                (count(ce.id) FILTER (WHERE ce.status = 'cancelled'))::int AS cancelled,
                (count(ce.id) FILTER (WHERE ce.status = 'scheduled'))::int AS scheduled
           FROM script_bulk_executions r
           LEFT JOIN tunnel_command_executions ce ON ce.bulk_execution_id = r.id
           LEFT JOIN users u ON u.id = r.requested_by
          WHERE r.saved_script_id = $1
          GROUP BY r.id, u.username
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $2 OFFSET $3`,
        [id, query.pageSize, offset]
      ),
      pool.query("SELECT count(*)::int AS total FROM script_bulk_executions WHERE saved_script_id = $1", [id])
    ]);
    const total = countResult.rows[0]?.total as number ?? 0;
    return { runs: runsResult.rows, pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) } };
  });

  app.get("/api/scripts/:id/bulk-executions/:runId", { preHandler: requireAuth }, async (request, reply) => {
    const { id, runId } = z.object({ id: z.string().uuid(), runId: z.string().uuid() }).parse(request.params);
    const query = z.object({
      status: z.enum(["scheduled", "running", "succeeded", "failed", "timed_out", "cancelled"]).optional(),
      tunnelId: z.string().uuid().optional(),
      tunnelSearch: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(5).max(100).default(25)
    }).parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const runResult = await pool.query(
      `SELECT r.id, r.name, r.description,
              r.saved_script_version_id AS "scriptVersionId", r.timeout_ms AS "timeoutMs", r.argument_overrides AS "argumentBindings",
              r.created_at AS "createdAt", u.username AS "requestedBy"
         FROM script_bulk_executions r
         LEFT JOIN users u ON u.id = r.requested_by
        WHERE r.id = $1 AND r.saved_script_id = $2`,
      [runId, id]
    );
    if (!runResult.rowCount) return reply.code(404).send({ error: "Bulk execution not found" });
    const values: unknown[] = [runId];
    const conditions = ["ce.bulk_execution_id = $1"];
    if (query.status) { values.push(query.status); conditions.push(`ce.status = $${values.length}`); }
    if (query.tunnelId) { values.push(query.tunnelId); conditions.push(`ce.tunnel_id = $${values.length}`); }
    if (query.tunnelSearch) {
      values.push(query.tunnelSearch);
      conditions.push(`EXISTS (
        SELECT 1 FROM tunnels search_tunnel
         WHERE search_tunnel.id = ce.tunnel_id
           AND strpos(lower(concat_ws(' ', search_tunnel.display_name, search_tunnel.tenant_code, search_tunnel.tunnel_code)), lower($${values.length})) > 0
      )`);
    }
    const where = conditions.join(" AND ");
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const [executionResult, countResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT ce.id, ce.tunnel_id AS "tunnelId", st.display_name AS "tunnelDisplayName",
                st.tenant_code AS "tenantCode", st.tunnel_code AS "tunnelCode",
                ce.enrollment_id AS "enrollmentId",
                NULLIF(e.host_info->>'machineName', '') AS "computerName",
                NULLIF(e.host_info->>'osName', '') AS "osName",
                e.platform AS environment, e.platform AS "enrollmentPlatform",
                ce.script_type AS "scriptType",
                ce.bulk_execution_id AS "bulkExecutionId",
                ce.script_version_id AS "scriptVersionId", ce.saved_script_id AS "savedScriptId",
                ce.saved_script_version_id AS "savedScriptVersionId", ce.script_name AS "scriptName",
                ce.script_version_number AS "scriptVersion", ce.script_platform AS platform,
                ce.script_language AS language, ce.script, ce.environment_variables AS "environmentVariables", ce.argument_sources AS "argumentSources", COALESCE(sv.arguments, ce.inline_arguments) AS "scriptArguments", ce.timeout_ms AS "timeoutMs", ce.status,
                ce.task_id AS "taskId", ce.process_id AS "processId",
                ce.created_at AS "createdAt", ce.started_at AS "startedAt", ce.finished_at AS "finishedAt", ce.elapsed_ms AS "elapsedMs",
                ce.exit_code AS "exitCode", ce.stdout, ce.stderr, ce.error, u.username AS "requestedBy"
           FROM tunnel_command_executions ce
           JOIN tunnels st ON st.id = ce.tunnel_id
           LEFT JOIN enrollments e ON e.id = ce.enrollment_id
           LEFT JOIN users u ON u.id = ce.requested_by
           LEFT JOIN managed_script_versions sv ON sv.id = ce.script_version_id
          WHERE ${where}
          ORDER BY ce.created_at ASC, ce.id ASC
          LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
        [...values, query.pageSize, offset]
      ),
      pool.query(`SELECT count(*)::int AS total FROM tunnel_command_executions ce WHERE ${where}`, values),
      pool.query(
        `SELECT count(*)::int AS total,
                (count(*) FILTER (WHERE status = 'running'))::int AS running,
                (count(*) FILTER (WHERE status = 'succeeded'))::int AS succeeded,
                (count(*) FILTER (WHERE status = 'failed'))::int AS failed,
                (count(*) FILTER (WHERE status = 'timed_out'))::int AS "timedOut",
                (count(*) FILTER (WHERE status = 'cancelled'))::int AS cancelled,
                (count(*) FILTER (WHERE status = 'scheduled'))::int AS scheduled
           FROM tunnel_command_executions WHERE bulk_execution_id = $1`,
        [runId]
      )
    ]);
    return {
      run: runResult.rows[0],
      summary: statsResult.rows[0],
      executions: executionResult.rows,
      pagination: { page: query.page, pageSize: query.pageSize, total: countResult.rows[0].total, totalPages: Math.max(1, Math.ceil(Number(countResult.rows[0].total) / query.pageSize)) }
    };
  });

  app.post("/api/scripts/:id/bulk-execute", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = bulkExecuteSchema.parse(request.body);
    const selectedVersion = await pool.query(
      `SELECT v.id, v.version, v.content, v.arguments, s.id AS "scriptId", s.name AS "scriptName", s.platform, s.language,
              s.default_timeout_ms AS "defaultTimeoutMs"
         FROM managed_script_versions v JOIN managed_scripts s ON s.id = v.script_id
        WHERE v.id = $1 AND s.id = $2`,
      [body.scriptVersionId, id]
    );
    const version = selectedVersion.rows[0];
    if (!version) return reply.code(404).send({ error: "Script version not found" });
    const filters = body.filters;
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (body.selectAll) {
      conditions.push("TRUE");
      appendNameFilter(conditions, values, ["s.display_name", "s.tunnel_code"], filters);
      if (filters.tenantCode) { values.push(`%${filters.tenantCode}%`); conditions.push(`s.tenant_code ILIKE $${values.length}`); }
      if (filters.cfTunnelStatus) { values.push(filters.cfTunnelStatus); conditions.push(`s.cf_tunnel_status = $${values.length}`); }
      if (filters.enrollmentStatus) { values.push(filters.enrollmentStatus); conditions.push(`${onboardingStatusExpression} = $${values.length}`); }
      if (body.excludeTunnelIds?.length) { values.push(body.excludeTunnelIds); conditions.push(`s.id <> ALL($${values.length}::uuid[])`); }
      // "Select all matching filters" must only ever target tunnels the picker
      // could have shown, so a platform mismatch can't sneak into the run unselected.
      values.push(version.platform);
      conditions.push(`(CASE WHEN e.platform = 'windows' THEN 'windows' WHEN e.platform IS NOT NULL THEN 'unix' ELSE NULL END) = $${values.length}`);
    }
    const tunnelIds = body.selectAll ? undefined : body.tunnelIds;
    if (!tunnelIds?.length && !body.selectAll) return reply.code(400).send({ error: "No tunnels selected" });
    if (tunnelIds?.length) { values.push(tunnelIds); conditions.push(`s.id = ANY($${values.length}::uuid[])`); }
    const targetResult = await pool.query(
      `SELECT s.id, e.id AS "enrollmentId", e.platform,
              e.status AS "enrollmentRawStatus"
         FROM tunnels s
         ${latestEnrollmentJoin}
         LEFT JOIN LATERAL (
           SELECT e.id, e.platform, e.status
             FROM enrollments e
            WHERE e.tunnel_id = s.id AND e.status IN ('ready', 'installed')
              AND e.unenrolled_at IS NULL AND e.deleted_at IS NULL
            ORDER BY COALESCE(e.installed_at, e.claimed_at, e.created_at) DESC
            LIMIT 1
         ) e ON TRUE
        WHERE ${conditions.join(" AND ")}
        ORDER BY s.tenant_code, s.tunnel_code`,
      values
    );
    if (!targetResult.rowCount) return reply.code(409).send({ error: "No tunnels matched the selected filters" });
    const timeoutMs = body.timeoutMs ?? version.defaultTimeoutMs;
    const scriptArguments = scriptArgumentsSchema.parse(version.arguments);
    // A binding that nests one argument inside another is a static
    // misconfiguration - identical for every tunnel in the run - so it's
    // rejected once here, before any tunnel is targeted, instead of
    // failing every single per-tunnel execution the same way.
    try {
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid argument bindings" });
    }
    let availableByTunnel: Awaited<ReturnType<typeof resolveAvailableVariablesForTunnels>>;
    try {
      availableByTunnel = await resolveAvailableVariablesForTunnels(targetResult.rows.map((target) => target.id));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Unable to resolve available variables" });
    }
    const run = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO script_bulk_executions(saved_script_id, saved_script_version_id, name, description, timeout_ms, requested_by, argument_overrides)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [id, body.scriptVersionId, body.name, body.description, timeoutMs, request.authUser!.id, body.argumentBindings]
      );
      return inserted.rows[0] as { id: string };
    });
    const executions: string[] = [];
    const pending: Array<{ tunnelId: string; script: string; execution: Awaited<ReturnType<typeof createCommandExecution>> }> = [];
    for (const target of targetResult.rows) {
      const platform = target.platform === "windows" ? "windows" : "unix";
      const available = availableByTunnel.get(target.id);
      if (!available) continue;
      let argumentValues: ReturnType<typeof resolveArgumentValues>;
      let argumentSources: ReturnType<typeof describeArgumentValueSources>;
      try {
        argumentValues = resolveArgumentValues(scriptArguments, available.variables, body.argumentBindings);
        argumentSources = describeArgumentValueSources(scriptArguments, available.sources, body.argumentBindings);
      } catch (error) {
        const execution = await createCommandExecution({
          tunnelId: target.id,
          enrollmentId: target.enrollmentId ?? null,
          scriptVersionId: version.id,
          requestedBy: request.authUser!.id,
          script: version.content,
          timeoutMs,
          scriptType: "managed",
          scriptName: version.scriptName,
          scriptPlatform: version.platform,
          scriptLanguage: version.language,
          scriptVersion: version.version,
          environmentVariables: {},
          bulkExecutionId: run.id
        });
        executions.push(execution.executionId);
        await pool.query(
          `UPDATE tunnel_command_executions SET status = 'never_run', finished_at = now(), elapsed_ms = 0, error = $1 WHERE id = $2`,
          [error instanceof Error ? error.message : "Unable to resolve script arguments", execution.executionId]
        );
        continue;
      }
      const execution = await createCommandExecution({
        tunnelId: target.id,
        enrollmentId: target.enrollmentId ?? null,
        scriptVersionId: version.id,
        requestedBy: request.authUser!.id,
        script: version.content,
        timeoutMs,
        scriptType: "managed",
        scriptName: version.scriptName,
        scriptPlatform: version.platform,
        scriptLanguage: version.language,
        scriptVersion: version.version,
        environmentVariables: argumentValues,
        argumentSources,
        bulkExecutionId: run.id
      });
      executions.push(execution.executionId);
      if (!target.enrollmentId) {
        await pool.query(
          `UPDATE tunnel_command_executions SET status = 'never_run', finished_at = now(), elapsed_ms = 0, error = $1 WHERE id = $2`,
          ["This tunnel has no active enrollment", execution.executionId]
        );
        continue;
      }
      if (platform !== version.platform) {
        await pool.query(
          `UPDATE tunnel_command_executions SET status = 'failed', finished_at = now(), elapsed_ms = 0, error = $1 WHERE id = $2`,
          [`This script is for ${version.platform}, but the active enrollment is ${platform}`, execution.executionId]
        );
        continue;
      }
      pending.push({ tunnelId: target.id, script: applyScriptArguments(version.content, version.language, argumentValues), execution });
    }
    void (async () => {
      for (let index = 0; index < pending.length; index += 20) {
        const batch = pending.slice(index, index + 20);
        await Promise.allSettled(batch.map((item) => executeTunnelScript(item.tunnelId, item.script, timeoutMs, item.execution)));
      }
    })();
    await writeAudit({ actorUserId: request.authUser!.id, action: "script.bulk_executed", entityType: "script", entityId: id, details: { bulkExecutionId: run.id, name: body.name, selectedCount: executions.length, timeoutMs, argumentBindingNames: Object.keys(body.argumentBindings), excludedCount: body.excludeTunnelIds?.length ?? 0 } });
    return reply.code(202).send({ bulkExecutionId: run.id, scriptId: id, scriptVersionId: version.id, name: body.name, selectedCount: executions.length, executionIds: executions, timeoutMs });
  });

  app.post("/api/scripts", { preHandler: requireAuth }, async (request, reply) => {
    const body = scriptCreateSchema.parse(request.body);
    const languageError = validateLanguage(body.platform, body.language);
    if (languageError) return reply.code(400).send({ error: languageError });
    const created = await withTransaction(async (client) => {
      const script = await client.query(
        `INSERT INTO managed_scripts(name, platform, language, description, default_timeout_ms, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [body.name, body.platform, body.language, body.description, body.defaultTimeoutMs, request.authUser!.id]
      );
      const version = await client.query(
        `INSERT INTO managed_script_versions(script_id, version, content, arguments, created_by)
         VALUES ($1, 1, $2, $3, $4)
         RETURNING id, version`,
        [script.rows[0].id, body.content, JSON.stringify(body.arguments), request.authUser!.id]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "script.created",
        entityType: "script",
        entityId: script.rows[0].id,
        details: { platform: body.platform, language: body.language, version: 1 }
      }, client);
      return { id: script.rows[0].id as string, versionId: version.rows[0].id as string };
    });
    return reply.code(201).send({ id: created.id, versionId: created.versionId });
  });

  app.patch("/api/scripts/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = scriptUpdateSchema.parse(request.body);
    const current = await pool.query("SELECT platform, language FROM managed_scripts WHERE id = $1", [id]);
    if (!current.rowCount) return reply.code(404).send({ error: "Script not found" });
    const language = body.language ?? current.rows[0].language;
    const languageError = validateLanguage(current.rows[0].platform, language);
    if (languageError) return reply.code(400).send({ error: languageError });
    const result = await pool.query(
      `UPDATE managed_scripts
          SET name = COALESCE($1, name), language = COALESCE($2, language),
              description = COALESCE($3, description), default_timeout_ms = COALESCE($4, default_timeout_ms),
              updated_at = now()
        WHERE id = $5
        RETURNING id`,
      [body.name ?? null, body.language ?? null, body.description ?? null, body.defaultTimeoutMs ?? null, id]
    );
    await writeAudit({ actorUserId: request.authUser!.id, action: "script.updated", entityType: "script", entityId: id, details: body });
    return { success: Boolean(result.rowCount) };
  });

  app.delete("/api/scripts/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await withTransaction(async (client) => {
      const script = await client.query("SELECT id, name FROM managed_scripts WHERE id = $1 FOR UPDATE", [id]);
      if (!script.rowCount) return null;
      const executions = await client.query(
        `DELETE FROM tunnel_command_executions
          WHERE script_version_id IN (SELECT id FROM managed_script_versions WHERE script_id = $1)
             OR saved_script_id = $1
             OR saved_script_version_id IN (SELECT id FROM managed_script_versions WHERE script_id = $1)
        RETURNING id`,
        [id]
      );
      await client.query("DELETE FROM managed_scripts WHERE id = $1", [id]);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "script.deleted",
        entityType: "script",
        entityId: id,
        details: { name: script.rows[0].name, deletedExecutionCount: executions.rowCount }
      }, client);
      return {
        scriptId: id,
        scriptName: script.rows[0].name as string,
        deletedExecutionCount: executions.rowCount ?? 0
      };
    });
    if (!deleted) return reply.code(404).send({ error: "Script not found" });
    return { success: true, ...deleted };
  });

  app.post("/api/scripts/:id/versions", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = versionSchema.parse(request.body);
    const version = await withTransaction(async (client) => {
      const script = await client.query("SELECT id FROM managed_scripts WHERE id = $1 FOR UPDATE", [id]);
      if (!script.rowCount) return null;
      const next = await client.query("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM managed_script_versions WHERE script_id = $1", [id]);
      const inserted = await client.query(
        `INSERT INTO managed_script_versions(script_id, version, content, arguments, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, version`,
        [id, next.rows[0].version, body.content, JSON.stringify(body.arguments), request.authUser!.id]
      );
      await client.query("UPDATE managed_scripts SET updated_at = now() WHERE id = $1", [id]);
      await writeAudit({ actorUserId: request.authUser!.id, action: "script.version_created", entityType: "script", entityId: id, details: { version: inserted.rows[0].version } }, client);
      return inserted.rows[0];
    });
    if (!version) return reply.code(404).send({ error: "Script not found" });
    return reply.code(201).send({ versionId: version.id, version: version.version });
  });
}
