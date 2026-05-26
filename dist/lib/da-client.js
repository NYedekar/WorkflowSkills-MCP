// APS Design Automation v3 API client
const DA_REGION = process.env.APS_DA_REGION ?? "us-east";
const DA_BASE = `https://developer.api.autodesk.com/da/${DA_REGION}/v3`;
const OSS_BASE = "https://developer.api.autodesk.com/oss/v2";
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
// ── Activity ──────────────────────────────────────────────────────────────
export async function getActivity(token, qualifiedActivityId // e.g. "clientId.ActivityName+prod"
) {
    const res = await fetch(`${DA_BASE}/activities/${encodeURIComponent(qualifiedActivityId)}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404)
        return null;
    if (!res.ok)
        throw new DAError(`GET activity failed: ${res.statusText}`, res.status);
    return res.json();
}
// ── OSS bucket ────────────────────────────────────────────────────────────
export async function ensureBucket(token, bucketKey, policy = "transient") {
    const check = await fetch(`${OSS_BASE}/buckets/${bucketKey}/details`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (check.ok)
        return;
    if (check.status !== 404) {
        const body = await check.text();
        throw new DAError(`Bucket check failed: ${body}`, check.status);
    }
    const create = await fetch(`${OSS_BASE}/buckets`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ bucketKey, policyKey: policy }),
    });
    if (!create.ok) {
        const body = await create.text();
        throw new DAError(`Create bucket failed: ${body}`, create.status);
    }
}
// ── OSS upload (small payloads — inline data: URL or direct upload) ────────
export async function uploadJsonToOss(token, bucketKey, objectKey, payload) {
    const body = JSON.stringify(payload);
    const res = await fetch(`${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body, "utf-8").toString(),
        },
        body,
    });
    if (!res.ok) {
        const err = await res.text();
        throw new DAError(`OSS upload failed: ${err}`, res.status);
    }
    return `oss://${bucketKey}/${objectKey}`;
}
// ── WorkItem ──────────────────────────────────────────────────────────────
export async function submitWorkItem(token, activityId, args) {
    const res = await fetch(`${DA_BASE}/workitems`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ activityId, arguments: args }),
    });
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
        const res = await fetch(`${DA_BASE}/workitems/${workItemId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
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
export async function getSignedDownloadUrl(token, ossUrl // oss://bucketKey/objectKey
) {
    const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
    const slash = withoutScheme.indexOf("/");
    const bucketKey = withoutScheme.slice(0, slash);
    const objectKey = withoutScheme.slice(slash + 1);
    const res = await fetch(`${OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signed?access=read`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });
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
    const res = await fetch(`${OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signeds3download`, {
        headers: { Authorization: `Bearer ${token}` },
    });
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
export async function getSignedS3UploadUrl(token, bucketKey, objectKey, minutesExpiration = 60) {
    const url = `${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload` +
        `?minutesExpiration=${minutesExpiration}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`Get signed S3 upload URL failed: ${body}`, res.status);
    }
    return res.json();
}
export async function uploadToS3(signedUrl, fileBuffer, contentType) {
    const res = await fetch(signedUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: fileBuffer,
    });
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`S3 upload failed (HTTP ${res.status}): ${body}`, res.status);
    }
}
export async function finalizeS3Upload(token, bucketKey, objectKey, uploadKey) {
    const res = await fetch(`${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ uploadKey }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new DAError(`Finalize S3 upload failed: ${body}`, res.status);
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
