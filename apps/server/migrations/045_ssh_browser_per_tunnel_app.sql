-- Browser-rendered SSH cannot bind to a target the way RDP does: Cloudflare
-- rejects both `target_criteria` and private `destinations` on "ssh" typed
-- Access Applications ("target contexts are not available for ssh
-- applications" / "private destinations are not supported for ssh apps",
-- confirmed live). The only way Cloudflare associates an ssh app with a
-- real backend is the app's own domain matching a hostname that already has
-- a working tunnel ingress rule behind it - so each Linux tunnel now gets
-- its own Access Application fronting its own already-existing ssh://
-- ingress hostname, instead of one shared zone-wide dummy-IP domain.
-- The virtual-network/teamnet-route/infrastructure-target machinery (copied
-- from the RDP flow, which does need it for target_criteria) never did
-- anything useful for SSH and is removed along with it.
ALTER TABLE tunnels
  ADD COLUMN ssh_access_app_id text,
  DROP COLUMN ssh_vnet_id,
  DROP COLUMN ssh_route_id,
  DROP COLUMN ssh_target_id,
  DROP COLUMN ssh_target_hostname;

ALTER TABLE zones
  DROP COLUMN ssh_hostname,
  DROP COLUMN ssh_dns_record_id,
  DROP COLUMN ssh_access_app_id;
