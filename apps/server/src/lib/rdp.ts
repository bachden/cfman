import { writeAudit } from "./audit.js";
import { CloudflareClient } from "./cloudflare.js";
import { pool } from "./database.js";
import { checkBrowserRdpGateway } from "./monitor.js";
import { decryptSecret } from "./security.js";
import { slugifyLabel } from "./tunnels.js";

export type RdpProvisioningResult = {
  ready: boolean;
  url?: string;
  error?: string;
};

export async function provisionBrowserRdp(tunnelId: string): Promise<RdpProvisioningResult> {
  const db = await pool.connect();
  let lockKey = `cfman:rdp:${tunnelId}`;
  let tunnelExists = false;
  try {
    const identity = await db.query("SELECT account_id FROM tunnels WHERE id = $1", [tunnelId]);
    if (!identity.rowCount) throw new Error("Tunnel not found");
    tunnelExists = true;
    lockKey = `cfman:rdp-account:${identity.rows[0].account_id}`;
    await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    const result = await db.query(
      `SELECT s.id, s.tenant_code, s.tunnel_code, s.cf_tunnel_id, s.rdp_target_ip, s.rdp_port,
              s.rdp_vnet_id, s.rdp_route_id, s.rdp_target_id,
              a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
              a.rdp_allowed_emails, a.rdp_access_policy_id,
              z.id AS zone_row_id, z.name AS zone_name, z.cf_zone_id,
              z.rdp_hostname, z.rdp_dns_record_id, z.rdp_access_app_id
         FROM tunnels s
         JOIN cloudflare_accounts a ON a.id = s.account_id
         JOIN zones z ON z.id = s.zone_id
        WHERE s.id = $1`,
      [tunnelId]
    );
    const tunnel = result.rows[0];
    if (!tunnel) throw new Error("Tunnel not found");
    if (!tunnel.cf_tunnel_id || !tunnel.rdp_target_ip) throw new Error("Tunnel and RDP target IP are required");
    if (tunnel.provider_mode === "live" && (!tunnel.cf_account_id || !tunnel.api_token_encrypted || !tunnel.cf_zone_id)) {
      throw new Error("Cloudflare account or zone is not fully configured for RDP");
    }
    const allowedEmails = (tunnel.rdp_allowed_emails ?? []) as string[];
    if (tunnel.provider_mode === "live" && allowedEmails.length === 0) {
      throw new Error("Configure at least one RDP operator email on the Cloudflare account");
    }

    await db.query(
      "UPDATE tunnels SET rdp_status = 'provisioning', rdp_last_error = null, updated_at = now() WHERE id = $1",
      [tunnelId]
    );

    const client = new CloudflareClient(
      tunnel.cf_account_id ?? tunnel.account_row_id,
      tunnel.api_token_encrypted ? decryptSecret(tunnel.api_token_encrypted) : "mock",
      tunnel.provider_mode
    );
    const label = slugifyLabel(`${tunnel.tenant_code}-${tunnel.tunnel_code}`);
    const vnet = tunnel.rdp_vnet_id
      ? { id: tunnel.rdp_vnet_id as string, name: `cfman-${label}` }
      : await client.ensureVirtualNetwork(`cfman-${label}`);
    await db.query("UPDATE tunnels SET rdp_vnet_id = $1, updated_at = now() WHERE id = $2", [vnet.id, tunnelId]);

    const route = tunnel.rdp_route_id
      ? { id: tunnel.rdp_route_id as string }
      : await client.ensureTunnelRoute(tunnel.cf_tunnel_id, vnet.id, String(tunnel.rdp_target_ip));
    await db.query("UPDATE tunnels SET rdp_route_id = $1, updated_at = now() WHERE id = $2", [route.id, tunnelId]);

    const targetHostname = tunnel.rdp_target_hostname ?? `tunnel-${label}`;
    const target = tunnel.rdp_target_id
      ? { id: tunnel.rdp_target_id as string }
      : await client.ensureInfrastructureTarget(targetHostname, String(tunnel.rdp_target_ip), vnet.id);
    await db.query(
      "UPDATE tunnels SET rdp_target_id = $1, rdp_target_hostname = $2, updated_at = now() WHERE id = $3",
      [target.id, targetHostname, tunnelId]
    );

    const rdpHostname = tunnel.rdp_hostname ?? `rdp.${tunnel.zone_name}`;
    const dnsRecord = await client.ensureBrowserRdpDnsRecord(tunnel.cf_zone_id ?? "mock-zone", rdpHostname);
    await db.query(
      "UPDATE zones SET rdp_hostname = $1, rdp_dns_record_id = $2, updated_at = now() WHERE id = $3",
      [rdpHostname, dnsRecord.id, tunnel.zone_row_id]
    );

    const policy = await client.ensureRdpAccessPolicy(tunnel.rdp_access_policy_id, allowedEmails);
    await db.query(
      "UPDATE cloudflare_accounts SET rdp_access_policy_id = $1, updated_at = now() WHERE id = $2",
      [policy.id, tunnel.account_row_id]
    );

    const hostnames = await db.query(
      `SELECT DISTINCT rdp_target_hostname
         FROM tunnels
        WHERE zone_id = $1 AND rdp_target_id IS NOT NULL AND rdp_target_hostname IS NOT NULL
        ORDER BY rdp_target_hostname`,
      [tunnel.zone_row_id]
    );
    const application = await client.ensureBrowserRdpApplication({
      existingId: tunnel.rdp_access_app_id,
      name: `cfman RDP ${tunnel.zone_name}`,
      domain: rdpHostname,
      policyId: policy.id,
      targetHostnames: hostnames.rows.map((row) => row.rdp_target_hostname)
    });
    await db.query(
      "UPDATE zones SET rdp_access_app_id = $1, updated_at = now() WHERE id = $2",
      [application.id, tunnel.zone_row_id]
    );

    const rdpUrl = `https://${rdpHostname}/rdp/${encodeURIComponent(vnet.id)}/${encodeURIComponent(String(tunnel.rdp_target_ip))}/${tunnel.rdp_port}`;
    if (tunnel.provider_mode === "live") {
      const gateway = await checkBrowserRdpGateway(rdpUrl);
      if (!gateway.reachable) throw new Error(gateway.error ?? "Browser RDP gateway is not ready");
    }
    await db.query(
      `UPDATE tunnels SET rdp_status = 'ready', rdp_url = $1, rdp_last_error = null,
              updated_at = now() WHERE id = $2`,
      [rdpUrl, tunnelId]
    );
    await writeAudit({
      action: "tunnel.rdp_provisioned",
      entityType: "tunnel",
      entityId: tunnelId,
      details: { rdpHostname, targetHostname, targetIp: String(tunnel.rdp_target_ip), vnetId: vnet.id }
    }, db);
    return { ready: true, url: rdpUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : "RDP provisioning failed";
    if (tunnelExists) {
      await db.query(
        "UPDATE tunnels SET rdp_status = 'failed', rdp_last_error = $1, updated_at = now() WHERE id = $2",
        [message, tunnelId]
      );
      await writeAudit({
        action: "tunnel.rdp_failed",
        entityType: "tunnel",
        entityId: tunnelId,
        details: { error: message }
      }, db);
    }
    return { ready: false, error: message };
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
    db.release();
  }
}
