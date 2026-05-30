// APS Design Automation v3 API client
import { recordApiCall } from "./rate-limiter.js";
const DA_REGION = process.env.APS_DA_REGION ?? "us-east";
const DA_BASE = `https://developer.api.autodesk.com/da/${DA_REGION}/v3`;
const OSS_BASE = "https://developer.api.autodesk.com/oss/v2";
// ── Timeout-aware fetch ───────────────────────────────────────────────────
// Every APS/S3 call must have a deadline. Without one, a stalled TCP connection
// hangs the MCP server indefinitely and forces the user to resubmit.
// maxRetries=2 by default for all APS API calls.
// Pass maxRetries=0 for S3 PUT uploads — partial uploads cannot safely be retried.
async function fetchWithTimeout(url, options = {}, timeoutMs = 20_000, maxRetries = 2, parentSignal) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (parentSignal?.aborted)
            throw new DOMException("Aborted", "AbortError");
        if (attempt > 0)
            await sleep(1_000 * attempt); // 1s, 2s backoff
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const signal = parentSignal
            ? AbortSignal.any([controller.signal, parentSignal])
            : controller.signal;
        try {
            recordApiCall(); // count every outbound APS/S3 request toward RPM limit
            return await fetch(url, { ...options, signal });
        }
        catch (err) {
            clearTimeout(timer);
            const isRetryable = (err instanceof Error && err.name === "AbortError") || // timeout or parent abort
                (err instanceof TypeError); // connection reset / network error
            // Don't retry if the parent signal was the reason for abort
            if (!isRetryable || attempt === maxRetries || parentSignal?.aborted)
                throw err;
        }
        finally {
            clearTimeout(timer);
        }
    }
    throw new Error("fetchWithTimeout: exhausted retries");
}
// ── DA Nickname ───────────────────────────────────────────────────────────
// One lookup per client_id per process lifetime — nickname never changes.
const nicknameCache = new Map();
export async function getNickname(token, clientId) {
    const cached = nicknameCache.get(clientId);
    if (cached)
        return cached;
    try {
        const res = await fetchWithTimeout(`${DA_BASE}/forgeapps/me`, {
            headers: { Authorization: `Bearer ${token}` },
        }, 10_000);
        if (!res.ok)
            return clientId; // fall back silently — better than blocking execution
        const json = (await res.json());
        const nickname = json.nickname ?? json.id ?? clientId;
        nicknameCache.set(clientId, nickname);
        return nickname;
    }
    catch {
        return clientId;
    }
}
export class DAError extends Error {
    statusCode;
    body;
    constructor(message, statusCode, body) {
        super(message);
        this.statusCode = statusCode;
        this.body = body;
        this.name = "DAError";
    }
}
export async function getActivity(token, qualifiedActivityId // e.g. "clientId.ActivityName+prod"
) {
    const res = await fetchWithTimeout(`${DA_BASE}/activities/${encodeURIComponent(qualifiedActivityId)}`, {
        headers: { Authorization: `Bearer ${token}` },
    }, 15_000);
    if (res.status === 404)
        return null;
    if (!res.ok)
        throw new DAError(`GET activity failed: ${res.statusText}`, res.status);
    return res.json();
}
export async function createActivity(token, definition) {
    const res = await fetchWithTimeout(`${DA_BASE}/activities`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(definition),
    }, 20_000);
    // 409 = activity already exists — not an error
    if (!res.ok && res.status !== 409) {
        const body = await res.text();
        throw new DAError(`Create activity failed: ${body}`, res.status, body);
    }
}
export async function createActivityAlias(token, qualifiedActivityId, // e.g. "nickname.ActivityName" (no +alias suffix)
alias, version) {
    const res = await fetchWithTimeout(`${DA_BASE}/activities/${encodeURIComponent(qualifiedActivityId)}/aliases`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: alias, version }),
    }, 20_000);
    // 409 = alias already exists — not an error
    if (!res.ok && res.status !== 409) {
        const body = await res.text();
        throw new DAError(`Create activity alias failed: ${body}`, res.status, body);
    }
}
// ── OSS bucket ────────────────────────────────────────────────────────────
export async function ensureBucket(token, bucketKey, policy = "transient") {
    const check = await fetchWithTimeout(`${OSS_BASE}/buckets/${bucketKey}/details`, {
        headers: { Authorization: `Bearer ${token}` },
    }, 15_000);
    if (check.ok)
        return;
    if (check.status !== 404) {
        const body = await check.text();
        throw new DAError(`Bucket check failed: ${body}`, check.status);
    }
    const create = await fetchWithTimeout(`${OSS_BASE}/buckets`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ bucketKey, policyKey: policy }),
    }, 15_000);
    if (!create.ok) {
        const body = await create.text();
        throw new DAError(`Create bucket failed: ${body}`, create.status);
    }
}
// ── OSS upload (small payloads — inline data: URL or direct upload) ────────
export async function uploadJsonToOss(token, bucketKey, objectKey, payload) {
    const body = JSON.stringify(payload);
    const res = await fetchWithTimeout(`${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body, "utf-8").toString(),
        },
        body,
    }, 30_000);
    if (!res.ok) {
        const err = await res.text();
        throw new DAError(`OSS upload failed: ${err}`, res.status);
    }
    return `oss://${bucketKey}/${objectKey}`;
}
// ── WorkItem ──────────────────────────────────────────────────────────────
export async function submitWorkItem(token, activityId, args) {
    const res = await fetchWithTimeout(`${DA_BASE}/workitems`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ activityId, arguments: args }),
    }, 20_000);
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`Submit workitem failed: ${body}`, res.status, body);
    }
    const json = (await res.json());
    return json.id;
}
export async function pollWorkItem(token, workItemId, timeoutMs = 120_000, intervalMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const res = await fetchWithTimeout(`${DA_BASE}/workitems/${workItemId}`, {
            headers: { Authorization: `Bearer ${token}` },
        }, 10_000);
        if (!res.ok)
            throw new DAError(`Poll workitem failed: ${res.statusText}`, res.status);
        const item = (await res.json());
        if (item.status === "success" || item.status === "failed" || item.status === "cancelled") {
            return item;
        }
        await sleep(intervalMs);
    }
    throw new DAError(`WorkItem ${workItemId} timed out after ${timeoutMs}ms`);
}
// Batch status check for multiple work items in one HTTP call.
// DA v3 supports POST /v3/workitems/status with body { ids: string[] }.
// Used by batch-poller.ts to stay within APS 150 RPM limit at scale.
export async function getBatchWorkItemStatus(token, workItemIds) {
    if (workItemIds.length === 0)
        return new Map();
    const res = await fetchWithTimeout(`${DA_BASE}/workitems/status`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids: workItemIds }),
    }, 15_000, 1 // no retries for batch — stale data is preferable to double-hitting on partial success
    );
    if (!res.ok) {
        throw new DAError(`Batch workitem status failed: ${res.statusText}`, res.status);
    }
    const json = (await res.json());
    const items = Array.isArray(json) ? json : (json.results ?? []);
    const map = new Map();
    for (const item of items) {
        if (item.id)
            map.set(item.id, item);
    }
    return map;
}
export async function getSignedDownloadUrl(token, ossUrl // oss://bucketKey/objectKey
) {
    const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
    const slash = withoutScheme.indexOf("/");
    const bucketKey = withoutScheme.slice(0, slash);
    const objectKey = withoutScheme.slice(slash + 1);
    const res = await fetchWithTimeout(`${OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signed?access=read`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    }, 15_000);
    if (!res.ok) {
        const err = await res.text();
        throw new DAError(`Get signed URL failed: ${err}`, res.status);
    }
    const json = (await res.json());
    const signedUrl = json.signedUrl ?? json.signedurl;
    if (!signedUrl)
        throw new DAError("OSS signed URL response missing signedUrl field");
    return signedUrl;
}
// ── OSS Direct-to-S3 download (non-deprecated path) ───────────────────────
export async function getSignedS3DownloadUrl(token, ossUrl // oss://bucketKey/objectKey
) {
    const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
    const slash = withoutScheme.indexOf("/");
    const bucketKey = withoutScheme.slice(0, slash);
    const objectKey = withoutScheme.slice(slash + 1);
    const res = await fetchWithTimeout(`${OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signeds3download`, {
        headers: { Authorization: `Bearer ${token}` },
    }, 15_000);
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`Get signed S3 download URL failed: ${body}`, res.status);
    }
    // APS response: { status, url, params, size, sha1 }
    const json = (await res.json());
    const url = json.url ?? json.signedUrl;
    if (!url)
        throw new DAError("S3 download URL response missing url field");
    return url;
}
export async function getSignedS3UploadUrl(token, bucketKey, objectKey, minutesExpiration = 60, parts = 1) {
    const url = `${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload` +
        `?minutesExpiration=${minutesExpiration}&parts=${parts}`;
    const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${token}` },
    }, 15_000);
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`Get signed S3 upload URL failed: ${body}`, res.status);
    }
    return res.json();
}
export async function uploadToS3(signedUrl, fileBuffer, contentType) {
    const res = await fetchWithTimeout(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: fileBuffer,
    }, 120_000, 0); // no retry — partial S3 uploads cannot be safely retried
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`S3 upload failed (HTTP ${res.status}): ${body}`, res.status);
    }
}
export async function finalizeS3Upload(token, bucketKey, objectKey, uploadKey, signal) {
    const res = await fetchWithTimeout(`${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ uploadKey }),
    }, 20_000, 2, signal);
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`Finalize S3 upload failed: ${body}`, res.status);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
