// ── APS API rate limit telemetry ──────────────────────────────────────────
// Tracks outbound APS API calls per minute in-process.
// APS hard cap: 150 RPM (requests per minute) per client ID.
// Warn when approaching 80% (120 RPM). Surface as _rate_limit_warning in tool responses.
//
// This is observability-only — it does NOT throttle requests.
// At 6+ concurrent users, swap for a shared Redis counter.

const APS_RPM_HARD_LIMIT = 150;
const APS_RPM_WARN_THRESHOLD = Math.floor(APS_RPM_HARD_LIMIT * 0.8); // 120

// Sliding window: timestamps of API calls in the last 60 seconds.
const callTimestamps: number[] = [];

function pruneOld(): void {
  const cutoff = Date.now() - 60_000;
  let i = 0;
  while (i < callTimestamps.length && callTimestamps[i] < cutoff) i++;
  if (i > 0) callTimestamps.splice(0, i);
}

export function recordApiCall(): void {
  pruneOld();
  callTimestamps.push(Date.now());
}

export function getCurrentRpm(): number {
  pruneOld();
  return callTimestamps.length;
}

export interface RateLimitStatus {
  current_rpm: number;
  limit_rpm: number;
  warn_threshold_rpm: number;
  warning?: string;
}

export function getRateLimitStatus(): RateLimitStatus {
  const currentRpm = getCurrentRpm();
  const status: RateLimitStatus = {
    current_rpm: currentRpm,
    limit_rpm: APS_RPM_HARD_LIMIT,
    warn_threshold_rpm: APS_RPM_WARN_THRESHOLD,
  };

  if (currentRpm >= APS_RPM_HARD_LIMIT) {
    status.warning =
      `⚠️ APS rate limit reached: ${currentRpm}/${APS_RPM_HARD_LIMIT} RPM. ` +
      `Requests may be rejected (HTTP 429). Wait a few seconds before retrying.`;
  } else if (currentRpm >= APS_RPM_WARN_THRESHOLD) {
    status.warning =
      `⚠️ Approaching APS rate limit: ${currentRpm}/${APS_RPM_HARD_LIMIT} RPM (warn at ${APS_RPM_WARN_THRESHOLD}). ` +
      `Space out requests if possible.`;
  }

  return status;
}

export function getRateLimitWarning(): string | undefined {
  return getRateLimitStatus().warning;
}
