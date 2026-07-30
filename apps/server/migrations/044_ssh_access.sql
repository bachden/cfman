-- Adds Linux/unix SSH remote access, mirroring the existing browser RDP
-- support for Windows: the same virtual-network/infrastructure-target/
-- Access-application plumbing RDP uses for its browser-rendered gateway,
-- plus a per-account SSH keypair used to authorize the raw ssh:// ingress
-- route cfman also publishes automatically on successful Linux enrollment.
-- SSH reuses the account's existing rdp_allowed_emails as its operator list
-- rather than tracking a separate email allow-list.
ALTER TABLE cloudflare_accounts
  ADD COLUMN ssh_access_policy_id text,
  ADD COLUMN ssh_public_key text,
  ADD COLUMN ssh_private_key_encrypted text;

ALTER TABLE zones
  ADD COLUMN ssh_hostname text,
  ADD COLUMN ssh_dns_record_id text,
  ADD COLUMN ssh_access_app_id text;

ALTER TABLE tunnels
  ADD COLUMN ssh_status text NOT NULL DEFAULT 'pending'
    CHECK (ssh_status IN ('disabled', 'pending', 'enabled', 'provisioning', 'ready', 'failed')),
  ADD COLUMN ssh_target_ip inet,
  ADD COLUMN ssh_target_hostname text,
  ADD COLUMN ssh_port integer NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
  ADD COLUMN ssh_username text,
  ADD COLUMN ssh_vnet_id text,
  ADD COLUMN ssh_route_id text,
  ADD COLUMN ssh_target_id text,
  ADD COLUMN ssh_url text,
  ADD COLUMN ssh_last_error text;

CREATE INDEX tunnels_ssh_status_idx ON tunnels(ssh_status);
