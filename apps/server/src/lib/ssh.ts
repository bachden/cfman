import { writeAudit } from "./audit.js";
import { CloudflareClient } from "./cloudflare.js";
import { pool } from "./database.js";
import { checkBrowserSshGateway } from "./monitor.js";
import { decryptSecret } from "./security.js";

// Unlike RDP - which has no raw ingress protocol of its own and so must be
// auto-provisioned end to end - a Linux machine's ssh:// ingress route is
// just an ordinary publication the account creates through the normal Edit
// Connectivity flow (validatePublications already accepts ssh:// service
// URLs). cfman never creates that route on the account's behalf: doing so
// automatically produced routes the account didn't ask for and couldn't
// choose the hostname of. Browser SSH provisioning below only attaches to
// whichever ssh:// route already exists.
async function findSshRouteHostname(tunnelId: string): Promise<string | undefined> {
  const result = await pool.query(
    `SELECT p.hostname
       FROM tunnel_publications p
       JOIN tunnel_routes r ON r.publication_id = p.id
      WHERE p.tunnel_id = $1 AND r.service_url LIKE 'ssh://%'
      ORDER BY p.created_at
      LIMIT 1`,
    [tunnelId]
  );
  return result.rows[0]?.hostname as string | undefined;
}

export type SshProvisioningResult = {
  ready: boolean;
  url?: string;
  error?: string;
};

// Editing connectivity can rename or remove the tunnel's ssh:// route at any
// time, independently of enrollment - the DNS/ingress side of that follows
// automatically through the normal publication flow, but the browser SSH
// Access Application (gated on its own copy of the hostname) does not know
// to move or clean itself up. Call this after every connectivity save so the
// gateway always matches whatever ssh:// route currently exists: re-attaches
// to a renamed route (ensureBrowserSshApplication PUTs the app's domain,
// which browser SSH sync depends on to follow a rename), or tears the
// Access Application down if the route was removed entirely.
export async function syncBrowserSsh(tunnelId: string): Promise<void> {
  const result = await pool.query(
    `SELECT s.ssh_target_ip, s.ssh_access_app_id,
            a.provider_mode, a.cf_account_id, a.api_token_encrypted, a.id AS account_row_id
       FROM tunnels s
       JOIN cloudflare_accounts a ON a.id = s.account_id
      WHERE s.id = $1`,
    [tunnelId]
  );
  const tunnel = result.rows[0];
  if (!tunnel) return;
  const sshHostname = await findSshRouteHostname(tunnelId);
  if (sshHostname && tunnel.ssh_target_ip) {
    await provisionBrowserSsh(tunnelId);
    return;
  }
  if (!sshHostname && tunnel.ssh_access_app_id) {
    const client = new CloudflareClient(
      tunnel.cf_account_id ?? tunnel.account_row_id,
      tunnel.api_token_encrypted ? decryptSecret(tunnel.api_token_encrypted) : "mock",
      tunnel.provider_mode
    );
    await client.deleteAccessApplication(tunnel.ssh_access_app_id);
    await pool.query(
      `UPDATE tunnels SET ssh_access_app_id = null, ssh_url = null, ssh_status = 'disabled', ssh_last_error = null,
              updated_at = now() WHERE id = $1`,
      [tunnelId]
    );
  }
}

// Unlike RDP (rdp.ts), which shares one zone-wide placeholder domain across
// every Windows target via `target_criteria` and a URL-encoded deep link,
// Cloudflare's "ssh" Access Application type accepts no target-binding field
// at all - confirmed live: both `target_criteria` ("target contexts are not
// available for ssh applications") and a private `destinations` entry
// ("private destinations are not supported for ssh apps") are rejected. The
// only way Cloudflare knows which backend an ssh app proxies to is the app's
// own `domain` already being a real hostname with a working tunnel ingress
// behind it - so this attaches to whichever ssh:// route the account has
// already published for this tunnel (findSshRouteHostname), and does
// nothing if there isn't one yet. There is no virtual network / teamnet
// route / infrastructure target involved, unlike RDP. The Access policy's
// allowed usernames are still the union of every ssh_username reported by
// Linux enrollments across the whole account, since a Cloudflare Access
// policy - unlike the per-tunnel Access application - is account-scoped.
export async function provisionBrowserSsh(tunnelId: string): Promise<SshProvisioningResult> {
  const db = await pool.connect();
  let lockKey = `cfman:ssh:${tunnelId}`;
  let tunnelExists = false;
  try {
    const identity = await db.query("SELECT account_id FROM tunnels WHERE id = $1", [tunnelId]);
    if (!identity.rowCount) throw new Error("Tunnel not found");
    tunnelExists = true;
    lockKey = `cfman:ssh-account:${identity.rows[0].account_id}`;
    await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    const result = await db.query(
      `SELECT s.id, s.tenant_code, s.tunnel_code, s.cf_tunnel_id, s.ssh_target_ip, s.ssh_port,
              s.ssh_access_app_id,
              a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
              a.rdp_allowed_emails, a.ssh_access_policy_id,
              z.id AS zone_row_id, z.name AS zone_name, z.cf_zone_id
         FROM tunnels s
         JOIN cloudflare_accounts a ON a.id = s.account_id
         JOIN zones z ON z.id = s.zone_id
        WHERE s.id = $1`,
      [tunnelId]
    );
    const tunnel = result.rows[0];
    if (!tunnel) throw new Error("Tunnel not found");
    if (!tunnel.cf_tunnel_id || !tunnel.ssh_target_ip) throw new Error("Tunnel and SSH target IP are required");
    if (tunnel.provider_mode === "live" && (!tunnel.cf_account_id || !tunnel.api_token_encrypted || !tunnel.cf_zone_id)) {
      throw new Error("Cloudflare account or zone is not fully configured for SSH");
    }
    // SSH shares its allowed-operator list with Remote Desktop - the same
    // people who can browser-RDP into this account's Windows machines can
    // browser-SSH into its Linux ones, rather than tracking a second email
    // allow-list for what's the same "remote access operators" concept.
    const allowedEmails = (tunnel.rdp_allowed_emails ?? []) as string[];
    if (tunnel.provider_mode === "live" && allowedEmails.length === 0) {
      throw new Error("Configure at least one RDP/SSH operator email on the Cloudflare account");
    }

    await db.query(
      "UPDATE tunnels SET ssh_status = 'provisioning', ssh_last_error = null, updated_at = now() WHERE id = $1",
      [tunnelId]
    );

    const sshHostname = await findSshRouteHostname(tunnelId);
    if (!sshHostname) {
      throw new Error("Add an ssh:// ingress route for this tunnel (Edit Connectivity) before enabling browser SSH");
    }

    const client = new CloudflareClient(
      tunnel.cf_account_id ?? tunnel.account_row_id,
      tunnel.api_token_encrypted ? decryptSecret(tunnel.api_token_encrypted) : "mock",
      tunnel.provider_mode
    );

    const usernames = await db.query(
      `SELECT DISTINCT ssh_username
         FROM tunnels
        WHERE account_id = $1 AND ssh_username IS NOT NULL`,
      [tunnel.account_row_id]
    );
    const policy = await client.ensureSshAccessPolicy(
      tunnel.ssh_access_policy_id,
      allowedEmails,
      usernames.rows.map((row) => row.ssh_username as string)
    );
    await db.query(
      "UPDATE cloudflare_accounts SET ssh_access_policy_id = $1, updated_at = now() WHERE id = $2",
      [policy.id, tunnel.account_row_id]
    );

    const application = await client.ensureBrowserSshApplication({
      existingId: tunnel.ssh_access_app_id,
      name: `cfman SSH ${tunnel.tenant_code}-${tunnel.tunnel_code}`,
      domain: sshHostname,
      policyId: policy.id
    });
    await db.query(
      "UPDATE tunnels SET ssh_access_app_id = $1, updated_at = now() WHERE id = $2",
      [application.id, tunnelId]
    );

    const sshUrl = `https://${sshHostname}`;
    if (tunnel.provider_mode === "live") {
      const gateway = await checkBrowserSshGateway(sshUrl);
      if (!gateway.reachable) throw new Error(gateway.error ?? "Browser SSH gateway is not ready");
    }
    await db.query(
      `UPDATE tunnels SET ssh_status = 'ready', ssh_url = $1, ssh_last_error = null,
              updated_at = now() WHERE id = $2`,
      [sshUrl, tunnelId]
    );
    await writeAudit({
      action: "tunnel.ssh_provisioned",
      entityType: "tunnel",
      entityId: tunnelId,
      details: { sshHostname, targetIp: String(tunnel.ssh_target_ip) }
    }, db);
    return { ready: true, url: sshUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : "SSH provisioning failed";
    if (tunnelExists) {
      await db.query(
        "UPDATE tunnels SET ssh_status = 'failed', ssh_last_error = $1, updated_at = now() WHERE id = $2",
        [message, tunnelId]
      );
      await writeAudit({
        action: "tunnel.ssh_failed",
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
