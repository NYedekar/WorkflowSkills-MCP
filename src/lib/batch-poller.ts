import { EventEmitter } from "events";
import { getBatchWorkItemStatus } from "./da-client.js";
import { resolveCredential } from "../auth/credential-resolver.js";
import { jobRegistry, type JobState } from "./job-registry.js";

// ── Batch poller ──────────────────────────────────────────────────────────
// Replaces per-job individual GET /workitems/:id calls with a single
// POST /v3/workitems/status every POLL_INTERVAL_MS covering all registered jobs.
//
// APS rate limit: 150 RPM hard cap.
// At 5s interval: 12 RPM regardless of concurrent session count.
// Without this: 6 concurrent users × 25s polls = potentially 14+ RPM just for polling.
//
// Trigger: activate when jobRegistry has 2+ pending jobs to make batching worthwhile.
// The single-job path in get-workflow-status.ts already works fine at low volume.

const POLL_INTERVAL_MS = 5_000;
const DA_SCOPES = [
  "code:all",
  "data:read",
  "data:write",
  "data:create",
  "bucket:create",
  "bucket:read",
  "bucket:update",
];

export class BatchPoller extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) return; // already running
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.timer.unref(); // don't keep process alive on its own
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.running) return; // previous poll still in progress — skip
    this.running = true;
    try {
      const pending = jobRegistry.getPending();
      if (pending.length === 0) return;

      let token: string;
      try {
        const cred = await resolveCredential(DA_SCOPES);
        token = cred.access_token;
      } catch {
        // Auth failure — skip this cycle, will retry next interval
        return;
      }

      const ids = pending.map((j) => j.workItemId);
      let statusMap: Map<string, { status: string; reportUrl?: string; stats?: Record<string, unknown> }>;
      try {
        statusMap = await getBatchWorkItemStatus(token, ids) as Map<string, { status: string; reportUrl?: string; stats?: Record<string, unknown> }>;
      } catch {
        // Batch endpoint unavailable — skip this cycle; individual polls still work
        return;
      }

      for (const [workItemId, result] of statusMap.entries()) {
        const daStatus = result.status as JobState | "inprogress";
        const mappedState: JobState =
          daStatus === "inprogress" ? "inprogress" :
          daStatus === "success" ? "success" :
          daStatus === "failed" ? "failed" :
          daStatus === "cancelled" ? "cancelled" :
          "pending";

        const existing = jobRegistry.get(workItemId);
        if (!existing) continue;

        if (mappedState !== existing.state) {
          // Compute durationMs from DA stats if available
          let durationMs: number | undefined;
          const stats = result.stats as Record<string, string> | undefined;
          if (stats?.timeQueued && stats?.timeFinished) {
            durationMs = new Date(stats.timeFinished).getTime() - new Date(stats.timeQueued).getTime();
          }

          jobRegistry.update(workItemId, {
            state: mappedState,
            reportUrl: result.reportUrl,
            durationMs,
          });

          this.emit("jobUpdated", workItemId, mappedState);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

// Singleton batch poller — shared across all tool handlers.
export const batchPoller = new BatchPoller();

// Auto-start when the first job is registered.
jobRegistry.on("registered", () => {
  const pendingCount = jobRegistry.getPending().length;
  if (pendingCount >= 2) batchPoller.start();
});

// Auto-stop when no jobs are pending.
jobRegistry.on("terminal", () => {
  const pendingCount = jobRegistry.getPending().length;
  if (pendingCount === 0) batchPoller.stop();
});
