import type { Tunnel, TunnelPublication } from "../types";

// The single enrollment that currently "owns" a tunnel's active connection,
// if any - the same isCurrent/ready-or-installed/not-unenrolled rule the
// server itself uses to decide which enrollment is "active" (see
// onboardingStatusExpression, apps/server/src/routes/tunnels.ts). Its
// platform decides which remote-access section (Remote desktop for
// Windows, SSH for Linux/unix) the Connect tab can show - with no active
// enrollment yet, neither is known, so neither should render.
export function activeEnrollmentPlatform(tunnel: Pick<Tunnel, "enrollments">): "windows" | "unix" | null {
  const activeEnrollment = [...(tunnel.enrollments ?? [])]
    .filter((enrollment) => enrollment.isCurrent && ["ready", "installed"].includes(enrollment.status) && enrollment.unenrolledAt === null && enrollment.deletedAt === null)
    .sort((left, right) => new Date(right.installedAt ?? right.createdAt).getTime() - new Date(left.installedAt ?? left.createdAt).getTime())[0];
  return activeEnrollment?.platform ?? null;
}

const healthy = new Set(["active", "healthy", "verified", "installed", "enabled", "ready", "completed", "success", "succeeded", "connected", "waiting_for_new_enrollment", "online"]);
const warning = new Set(["url_issued", "claimed", "provisioning", "connector_online", "inactive", "pending", "scheduled", "running", "timed_out", "staled", "unenroll_pending", "unenroll_failed", "unverified", "degraded"]);
const danger = new Set(["failed", "cancelled", "unenroll_failed", "down", "invalid", "expired", "revoked", "offline"]);

export function StatusBadge({ status, label: customLabel }: { status: string; label?: string }) {
  const tone = healthy.has(status) ? "success" : warning.has(status) ? "warning" : danger.has(status) ? "danger" : "neutral";
  const label = customLabel ?? (status === "staled_ignored" ? "staled - ignored" : status === "waiting_for_new_enrollment" ? "waiting for new enrollment" : status.replaceAll("_", " "));
  return <span className={`status status-${tone}`}><i />{label}</span>;
}

const onlineCfTunnelStatuses = new Set(["healthy", "degraded"]);

export function tunnelOnlineStatus(cfTunnelStatus: string): "online" | "offline" {
  return onlineCfTunnelStatuses.has(cfTunnelStatus) ? "online" : "offline";
}

// A tunnel's onboarding status (list) or an individual enrollment's status
// (drawer) is "pending" while it can still resolve to a different outcome on
// its own - keep polling so the display updates without a manual refresh.
const pendingOnboardingStatuses = new Set(["url_issued", "claimed", "provisioning", "waiting_for_new_enrollment"]);
const pendingEnrollmentStatuses = new Set(["url_issued", "claimed", "provisioning", "ready"]);

export function isPendingOnboardingStatus(status: string): boolean {
  return pendingOnboardingStatuses.has(status);
}

export function isPendingEnrollmentStatus(status: string): boolean {
  return pendingEnrollmentStatuses.has(status);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

// The publication that makes this tunnel CFMan's own self-hosted target, if
// any - one of its published hostnames matches the server's own public base
// URL. Mirrors the server-side isCloudflareManPublicHostname check
// (route-waf.ts) so the badge and the reconcile button agree with what the
// backend will actually treat as "CFMan self" if asked to reconcile.
export function cfmanSelfPublication(tunnel: Pick<Tunnel, "publications">, publicBaseUrl: string | undefined): TunnelPublication | undefined {
  if (!publicBaseUrl) return undefined;
  let publicHostname: string;
  try {
    publicHostname = normalizeHostname(new URL(publicBaseUrl).hostname);
  } catch {
    return undefined;
  }
  return tunnel.publications.find((publication) => normalizeHostname(publication.hostname) === publicHostname);
}

export function isCfmanSelfTunnel(tunnel: Pick<Tunnel, "publications">, publicBaseUrl: string | undefined): boolean {
  return Boolean(cfmanSelfPublication(tunnel, publicBaseUrl));
}

// Single source of truth for "should this tunnel keep polling for updates" -
// shared by the tunnel list and the drawer so both refresh on the same signal
// instead of two conditions silently drifting apart.
export function tunnelNeedsFastPolling(tunnel: { onboardingStatus: string; latestEnrollmentStatus?: string | null; hasPendingActivity?: boolean; rdpStatus?: string; sshStatus?: string }): boolean {
  return isPendingOnboardingStatus(tunnel.onboardingStatus)
    || Boolean(tunnel.latestEnrollmentStatus && isPendingEnrollmentStatus(tunnel.latestEnrollmentStatus))
    || Boolean(tunnel.hasPendingActivity)
    || tunnel.rdpStatus === "provisioning"
    || tunnel.sshStatus === "provisioning";
}
