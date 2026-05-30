import { EventEmitter } from "events";
class JobRegistry extends EventEmitter {
    jobs = new Map();
    register(workItemId, outputOssUrls) {
        if (this.jobs.has(workItemId))
            return; // idempotent
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
    update(workItemId, patch) {
        const existing = this.jobs.get(workItemId);
        if (!existing)
            return;
        Object.assign(existing, patch, { updatedAt: Date.now() });
        this.emit("updated", workItemId, existing);
        if (patch.state && patch.state !== "pending" && patch.state !== "inprogress") {
            this.emit("terminal", workItemId, existing);
        }
    }
    get(workItemId) {
        return this.jobs.get(workItemId);
    }
    getAll() {
        return Array.from(this.jobs.values());
    }
    getPending() {
        return this.getAll().filter((j) => j.state === "pending" || j.state === "inprogress");
    }
    remove(workItemId) {
        this.jobs.delete(workItemId);
    }
    // Evict jobs older than maxAgeMs that have reached a terminal state.
    evictExpired(maxAgeMs = 24 * 60 * 60 * 1_000) {
        const cutoff = Date.now() - maxAgeMs;
        for (const [id, job] of this.jobs.entries()) {
            if (job.updatedAt < cutoff &&
                job.state !== "pending" &&
                job.state !== "inprogress") {
                this.jobs.delete(id);
            }
        }
    }
}
// Singleton — all tools share the same registry within one MCP server process.
export const jobRegistry = new JobRegistry();
// Evict stale records every 30 minutes.
setInterval(() => jobRegistry.evictExpired(), 30 * 60 * 1_000).unref();
