import { EventEmitter } from "events";

// ── Job registry ──────────────────────────────────────────────────────────
// In-memory map of active DA WorkItems keyed by workItemId.
// Used by the batch poller to avoid sending one status request per job per LLM turn.
// Capacity: unlimited in prototype; swap Map for BullMQ/Redis at 10+ concurrent sessions.

export type JobState = "pending" | "inprogress" | "success" | "failed" | "cancelled";

export interface JobRecord {
  workItemId: string;
  state: JobState;
  outputOssUrls: string[];
  reportUrl?: string;
  durationMs?: number;
  registeredAt: number;    // ms since epoch
  updatedAt: number;       // ms since epoch
  error?: string;
}

class JobRegistry extends EventEmitter {
  private jobs = new Map<string, JobRecord>();

  register(workItemId: string, outputOssUrls: string[]): void {
    if (this.jobs.has(workItemId)) return; // idempotent
    const now = Date.now();
    this.jobs.set(workItemId, {
      workItemId,
      state: "pending",
      outputOssUrls,
      registeredAt: now,
      updatedAt: now,
    });
    this.emit("registered", workItemId);
  }

  update(workItemId: string, patch: Partial<JobRecord>): void {
    const existing = this.jobs.get(workItemId);
    if (!existing) return;
    Object.assign(existing, patch, { updatedAt: Date.now() });
    this.emit("updated", workItemId, existing);
    if (patch.state && patch.state !== "pending" && patch.state !== "inprogress") {
      this.emit("terminal", workItemId, existing);
    }
  }

  get(workItemId: string): JobRecord | undefined {
    return this.jobs.get(workItemId);
  }

  getAll(): JobRecord[] {
    return Array.from(this.jobs.values());
  }

  getPending(): JobRecord[] {
    return this.getAll().filter((j) => j.state === "pending" || j.state === "inprogress");
  }

  remove(workItemId: string): void {
    this.jobs.delete(workItemId);
  }

  // Evict jobs older than maxAgeMs that have reached a terminal state.
  evictExpired(maxAgeMs = 24 * 60 * 60 * 1_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, job] of this.jobs.entries()) {
      if (
        job.updatedAt < cutoff &&
        job.state !== "pending" &&
        job.state !== "inprogress"
      ) {
        this.jobs.delete(id);
      }
    }
  }
}

// Singleton — all tools share the same registry within one MCP server process.
export const jobRegistry = new JobRegistry();

// Evict stale records every 30 minutes.
setInterval(() => jobRegistry.evictExpired(), 30 * 60 * 1_000).unref();
