// APS Design Automation v3 API client

const DA_REGION = process.env.APS_DA_REGION ?? "us-east";
const DA_BASE = `https://developer.api.autodesk.com/da/${DA_REGION}/v3`;
const OSS_BASE = "https://developer.api.autodesk.com/oss/v2";

// ── Types ─────────────────────────────────────────────────────────────────

export interface WorkItemArgument {
  url: string;
  verb: "get" | "put" | "patch";
  optional?: boolean;
  headers?: Record<string, string>;
}

export interface WorkItemResult {
  id: string;
  status: "pending" | "inprogress" | "cancelled" | "failed" | "success";
  stats?: {
    timeQueued?: string;
    timeDownloadStarted?: string;
    timeInstructionsStarted?: string;
    timeInstructionsEnded?: string;
    timeUploadEnded?: string;
    timeFinished?: string;
    bytesDownloaded?: number;
    bytesUploaded?: number;
  };
  reportUrl?: string;
}

export class DAError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "DAError";
  }
}

// ── Activity ──────────────────────────────────────────────────────────────

export async function getActivity(
  token: string,
  qualifiedActivityId: string // e.g. "clientId.ActivityName+prod"
): Promise<unknown | null> {
  const res = await fetch(`${DA_BASE}/activities/${encodeURIComponent(qualifiedActivityId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new DAError(`GET activity failed: ${res.statusText}`, res.status);
  return res.json();
}

// ── OSS bucket ────────────────────────────────────────────────────────────

export async function ensureBucket(
  token: string,
  bucketKey: string,
  policy: "transient" | "temporary" | "persistent" = "transient"
): Promise<void> {
  const check = await fetch(`${OSS_BASE}/buckets/${bucketKey}/details`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (check.ok) return;
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

export async function uploadJsonToOss(
  token: string,
  bucketKey: string,
  objectKey: string,
  payload: unknown
): Promise<string> {
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

export async function submitWorkItem(
  token: string,
  activityId: string,
  args: Record<string, WorkItemArgument>
): Promise<string> {
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

  const json = (await res.json()) as { id: string };
  return json.id;
}

export async function pollWorkItem(
  token: string,
  workItemId: string,
  timeoutMs = 120_000,
  intervalMs = 3_000
): Promise<WorkItemResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${DA_BASE}/workitems/${workItemId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new DAError(`Poll workitem failed: ${res.statusText}`, res.status);

    const item = (await res.json()) as WorkItemResult;

    if (item.status === "success" || item.status === "failed" || item.status === "cancelled") {
      return item;
    }

    await sleep(intervalMs);
  }

  throw new DAError(`WorkItem ${workItemId} timed out after ${timeoutMs}ms`);
}

export async function getSignedDownloadUrl(
  token: string,
  ossUrl: string // oss://bucketKey/objectKey
): Promise<string> {
  const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
  const slash = withoutScheme.indexOf("/");
  const bucketKey = withoutScheme.slice(0, slash);
  const objectKey = withoutScheme.slice(slash + 1);

  const res = await fetch(
    `${OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signed?access=read`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new DAError(`Get signed URL failed: ${err}`, res.status);
  }

  const json = (await res.json()) as { signedUrl?: string; signedurl?: string };
  const signedUrl = json.signedUrl ?? json.signedurl;
  if (!signedUrl) throw new DAError("OSS signed URL response missing signedUrl field");
  return signedUrl;
}

// ── OSS Direct-to-S3 download (non-deprecated path) ───────────────────────

export async function getSignedS3DownloadUrl(
  token: string,
  ossUrl: string // oss://bucketKey/objectKey
): Promise<string> {
  const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
  const slash = withoutScheme.indexOf("/");
  const bucketKey = withoutScheme.slice(0, slash);
  const objectKey = withoutScheme.slice(slash + 1);

  const res = await fetch(
    `${OSS_BASE}/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}/signeds3download`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new DAError(`Get signed S3 download URL failed: ${body}`, res.status);
  }

  // APS response: { status, url, params, size, sha1 }
  const json = (await res.json()) as { url?: string; signedUrl?: string; status?: string };
  const url = json.url ?? json.signedUrl;
  if (!url) throw new DAError("S3 download URL response missing url field");
  return url;
}

// ── OSS Direct-to-S3 upload ───────────────────────────────────────────────

export interface SignedUploadResponse {
  uploadKey: string;
  urls: string[];
}

export async function getSignedS3UploadUrl(
  token: string,
  bucketKey: string,
  objectKey: string,
  minutesExpiration = 60
): Promise<SignedUploadResponse> {
  const url =
    `${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload` +
    `?minutesExpiration=${minutesExpiration}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new DAError(`Get signed S3 upload URL failed: ${body}`, res.status);
  }

  return res.json() as Promise<SignedUploadResponse>;
}

export async function uploadToS3(signedUrl: string, fileBuffer: Buffer, contentType: string): Promise<void> {
  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileBuffer as unknown as BodyInit,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new DAError(`S3 upload failed (HTTP ${res.status}): ${body}`, res.status);
  }
}

export async function finalizeS3Upload(
  token: string,
  bucketKey: string,
  objectKey: string,
  uploadKey: string
): Promise<void> {
  const res = await fetch(
    `${OSS_BASE}/buckets/${bucketKey}/objects/${encodeURIComponent(objectKey)}/signeds3upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uploadKey }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new DAError(`Finalize S3 upload failed: ${body}`, res.status);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
