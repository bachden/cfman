import { Ban, CheckCircle2, CircleX, Clock3, LoaderCircle, TimerOff } from "lucide-react";
import type { ExecutionStats } from "../types";

export function ExecutionStatsSummary({ stats, compact = false }: { stats: ExecutionStats; compact?: boolean }) {
  return (
    <span className={`execution-stats ${compact ? "execution-stats-compact" : ""}`} aria-label={`${stats.scheduled} scheduled, ${stats.running} running, ${stats.succeeded} succeeded, ${stats.failed} errors, ${stats.timedOut} timeouts, ${stats.cancelled} cancelled`}>
      {stats.scheduled > 0 && <span className="execution-stat execution-stat-scheduled" title="Scheduled"><Clock3 size={12} /><strong>{stats.scheduled}</strong>{!compact && <small>Scheduled</small>}</span>}
      {stats.running > 0 && <span className="execution-stat execution-stat-running" title="Running"><LoaderCircle size={12} /><strong>{stats.running}</strong>{!compact && <small>Running</small>}</span>}
      <span className={`execution-stat execution-stat-succeeded ${stats.succeeded === 0 ? "execution-stat-zero" : ""}`} title="Succeeded"><CheckCircle2 size={12} /><strong>{stats.succeeded}</strong>{!compact && <small>Succeeded</small>}</span>
      <span className={`execution-stat execution-stat-failed ${stats.failed === 0 ? "execution-stat-zero" : ""}`} title="Error"><CircleX size={12} /><strong>{stats.failed}</strong>{!compact && <small>Error</small>}</span>
      <span className={`execution-stat execution-stat-timeout ${stats.timedOut === 0 ? "execution-stat-zero" : ""}`} title="Timeout"><TimerOff size={12} /><strong>{stats.timedOut}</strong>{!compact && <small>Timeout</small>}</span>
      {stats.cancelled > 0 && <span className="execution-stat execution-stat-cancelled" title="Cancelled"><Ban size={12} /><strong>{stats.cancelled}</strong>{!compact && <small>Cancelled</small>}</span>}
    </span>
  );
}
