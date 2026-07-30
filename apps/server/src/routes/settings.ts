import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { BRAND_ICONS, getBranding, getPublicBaseUrlSetting, normalizePublicBaseUrl, setBranding, setPublicBaseUrl } from "../lib/app-settings.js";
import { requireAuth, requireSessionAuth } from "../lib/auth.js";
import { withTransaction } from "../lib/database.js";
import { getMcpAccessSetting, rotateMcpToken, setMcpEnabled } from "../lib/mcp-access.js";
import { executionVariablesSchema, getGlobalExecutionVariables } from "../lib/execution-variables.js";
import { disableCloudflareManPublicHostnameWaf, ensureCloudflareManRemoteAgentRoutes } from "../lib/route-waf.js";

const settingsSchema = z.object({
  publicBaseUrl: z.string().trim().min(1).max(500).transform((value, context) => {
    try {
      return normalizePublicBaseUrl(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid public base URL" });
      return z.NEVER;
    }
  })
});

const mcpSettingsSchema = z.object({ enabled: z.boolean() });
const executionVariableSettingsSchema = z.object({ variables: executionVariablesSchema });
const brandingSchema = z.object({
  icon: z.enum(BRAND_ICONS),
  title: z.string().trim().min(1).max(40),
  subtitle: z.string().trim().min(1).max(80)
});

async function settingsResponse() {
  const [publicSetting, mcpAccess, executionVariables, branding] = await Promise.all([getPublicBaseUrlSetting(), getMcpAccessSetting(), getGlobalExecutionVariables(), getBranding()]);
  return {
    ...publicSetting,
    executionVariables,
    branding,
    mcp: {
      ...mcpAccess,
      endpoint: `${publicSetting.publicBaseUrl}/mcp`
    }
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: requireAuth }, async () => ({ settings: await settingsResponse() }));

  app.put("/api/settings", { preHandler: requireAuth }, async (request) => {
    const body = settingsSchema.parse(request.body);
    const publicBaseUrl = await withTransaction(async (client) => {
      const value = await setPublicBaseUrl(body.publicBaseUrl, request.authUser!.id, client);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "settings.public_base_url_updated",
        entityType: "settings",
        entityId: "public_base_url",
        details: { publicBaseUrl: value },
        ipAddress: request.ip
      }, client);
      return value;
    });
    const newHostname = new URL(publicBaseUrl).hostname;
    await ensureCloudflareManRemoteAgentRoutes(newHostname);
    const wafResult = await disableCloudflareManPublicHostnameWaf(newHostname);
    if (wafResult.failures.length) {
      request.log.error({ failures: wafResult.failures }, "Unable to reconcile WAF on the CFMan public hostname");
    }
    return { settings: await settingsResponse() };
  });

  app.put("/api/settings/execution-variables", { preHandler: requireAuth }, async (request) => {
    const body = executionVariableSettingsSchema.parse(request.body);
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO app_settings(key, value, updated_by, updated_at)
         VALUES ('execution_variables', $1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(body.variables), request.authUser!.id]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "settings.execution_variables_updated",
        entityType: "settings",
        entityId: "execution_variables",
        details: { variableNames: Object.keys(body.variables) },
        ipAddress: request.ip
      }, client);
    });
    return { variables: body.variables };
  });

  app.put("/api/settings/branding", { preHandler: requireAuth }, async (request) => {
    const body = brandingSchema.parse(request.body);
    const branding = await withTransaction(async (client) => {
      const value = await setBranding(body, request.authUser!.id, client);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "settings.branding_updated",
        entityType: "settings",
        entityId: "branding",
        details: value,
        ipAddress: request.ip
      }, client);
      return value;
    });
    return { branding };
  });

  app.patch("/api/settings/mcp", { preHandler: requireSessionAuth }, async (request) => {
    const body = mcpSettingsSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const updated = await setMcpEnabled(body.enabled, request.authUser!.id, client);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: body.enabled ? "settings.mcp_enabled" : "settings.mcp_disabled",
        entityType: "settings",
        entityId: "mcp_access",
        details: { enabled: body.enabled },
        ipAddress: request.ip
      }, client);
      return updated;
    });
    const publicSetting = await getPublicBaseUrlSetting();
    return {
      settings: { ...result.setting, endpoint: `${publicSetting.publicBaseUrl}/mcp` },
      ...(result.token ? { token: result.token } : {})
    };
  });

  app.post("/api/settings/mcp/rotate", { preHandler: requireSessionAuth }, async (request) => {
    const result = await withTransaction(async (client) => {
      const updated = await rotateMcpToken(request.authUser!.id, client);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "settings.mcp_token_rotated",
        entityType: "settings",
        entityId: "mcp_access",
        details: { tokenHint: updated.setting.tokenHint },
        ipAddress: request.ip
      }, client);
      return updated;
    });
    const publicSetting = await getPublicBaseUrlSetting();
    return {
      settings: { ...result.setting, endpoint: `${publicSetting.publicBaseUrl}/mcp` },
      token: result.token
    };
  });
}
