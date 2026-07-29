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

// Single source of truth for "should this tunnel keep polling for updates" -
// shared by the tunnel list and the drawer so both refresh on the same signal
// instead of two conditions silently drifting apart.
export function tunnelNeedsFastPolling(tunnel: { onboardingStatus: string; latestEnrollmentStatus?: string | null; hasPendingActivity?: boolean }): boolean {
  return isPendingOnboardingStatus(tunnel.onboardingStatus)
    || Boolean(tunnel.latestEnrollmentStatus && isPendingEnrollmentStatus(tunnel.latestEnrollmentStatus))
    || Boolean(tunnel.hasPendingActivity);
}
