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

// Identifies a tunnel_command_executions row as the one dispatched by
// "Enable RDS" (as opposed to an ordinary saved/inline script an operator
// ran), so the async command-execution report callback (enrollment.ts)
// knows to run completeRdpEnableExecution once the agent reports back.
export const RDP_ENABLE_SCRIPT_MARKER = "__cfman_rdp_enable__";

// The registry/firewall/service logic that used to run unconditionally at
// install time, now dispatched on demand through the same command-agent
// channel used for ordinary script execution (see
// POST /api/tunnels/:id/rdp/enable). Emits a single JSON line so the
// server can parse the result regardless of whether the agent returns it
// synchronously or via the scheduled/report callback path.
export function rdpEnableScript(): string {
  return `$ErrorActionPreference = "Stop"
$result = @{ rdpEnabled = $false; rdpTargetIp = $null; rdpPort = 3389; error = $null }
try {
  $terminalServer = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server"
  $rdpTcp = Join-Path $terminalServer "WinStations\\RDP-Tcp"
  Set-ItemProperty -Path $terminalServer -Name "fDenyTSConnections" -Value 0
  Set-ItemProperty -Path $rdpTcp -Name "SecurityLayer" -Value 1
  Set-ItemProperty -Path $rdpTcp -Name "UserAuthentication" -Value 1
  Get-NetFirewallRule -Name "RemoteDesktop*" -ErrorAction Stop | Enable-NetFirewallRule
  Set-Service -Name "TermService" -StartupType Automatic
  Start-Service -Name "TermService"
  $targetIp = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -and -not $_.StartsWith("169.254.") } |
    Select-Object -First 1
  if (-not $targetIp) { throw "Unable to determine the tunnel LAN IPv4 address." }
  $listenerReady = $false
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if (Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue) { $listenerReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $listenerReady) { throw "Windows Remote Desktop did not start listening on port 3389." }
  $result.rdpEnabled = $true
  $result.rdpTargetIp = $targetIp
} catch {
  $result.error = $_.Exception.Message
}
$result | ConvertTo-Json -Compress
`;
}

// Parses the JSON line rdpEnableScript() prints, persists the discovered
// target IP, and - on success - kicks off the same Cloudflare-side
// provisioning as a manual "Retry RDP". Called both from the synchronous
// path in POST /api/tunnels/:id/rdp/enable and from the async
// command-execution report callback in enrollment.ts, since a command
// agent may answer either immediately or via a later report.
export async function completeRdpEnableExecution(tunnelId: string, stdout: string): Promise<RdpProvisioningResult> {
  let parsed: { rdpEnabled?: boolean; rdpTargetIp?: string; rdpPort?: number; error?: string };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    const message = "Unexpected output from the RDP-enable command";
    await pool.query(
      "UPDATE tunnels SET rdp_status = 'failed', rdp_last_error = $1, updated_at = now() WHERE id = $2",
      [message, tunnelId]
    );
    return { ready: false, error: message };
  }
  if (!parsed.rdpEnabled || !parsed.rdpTargetIp) {
    const message = parsed.error || "Windows Remote Desktop could not be enabled";
    await pool.query(
      "UPDATE tunnels SET rdp_status = 'failed', rdp_last_error = $1, updated_at = now() WHERE id = $2",
      [message, tunnelId]
    );
    return { ready: false, error: message };
  }
  await pool.query(
    "UPDATE tunnels SET rdp_target_ip = $1, rdp_port = $2, updated_at = now() WHERE id = $3",
    [parsed.rdpTargetIp, parsed.rdpPort ?? 3389, tunnelId]
  );
  return provisionBrowserRdp(tunnelId);
}

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
