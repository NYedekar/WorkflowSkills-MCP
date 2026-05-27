import { readFileSync, statSync, existsSync } from "fs";
import { basename, extname } from "path";
import { homedir } from "os";
import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";
import {
  getSignedS3UploadUrl,
  uploadToS3,
  finalizeS3Upload,
  getSignedDownloadUrl,
  DAError,
} from "../lib/da-client.js";

// ── Schema ────────────────────────────────────────────────────────────────

export const uploadFileSchema = z.object({
  file_path: z
    .string()
    .describe(
      "Full path to the file — local folder, ~/Downloads/, or OneDrive (e.g. ~/Library/CloudStorage/OneDrive-Autodesk/…). " +
        "Chat attachments (/mnt/user-data/uploads/) cannot be read by the MCP server — " +
        "on bridge_required, ask the user for the file's actual Mac path."
    ),
  bucket_key: z
    .string()
    .optional()
    .describe(
      "Target OSS bucket key. Created automatically if it doesn't exist. " +
        "Defaults to '{clientId}-uploads'. " +
        "Bucket keys: lowercase letters, numbers, and hyphens only, 3–128 chars."
    ),
  object_key: z
    .string()
    .optional()
    .describe(
      "Object name within the bucket. Defaults to the filename from file_path. " +
        "Use a path-style key to organise uploads, e.g. 'revit/2024/project.rvt'."
    ),
  bucket_policy: z
    .enum(["transient", "temporary", "persistent"])
    .optional()
    .default("transient")
    .describe(
      "Retention policy for a newly created bucket. " +
        "'transient' = 24h TTL (default, good for workflow inputs), " +
        "'temporary' = 30-day TTL, " +
        "'persistent' = no automatic deletion."
    ),
  signed_url_expiry_minutes: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .default(60)
    .describe("Expiry in minutes for the returned signed download URL. Default: 60."),
});

export type UploadFileInput = z.infer<typeof uploadFileSchema>;

export interface UploadFileResult {
  status: "success" | "bridge_required" | "error";
  oss_url?: string;
  signed_download_url?: string;
  bucket_key?: string;
  object_key?: string;
  file_size_bytes?: number;
  content_type?: string;
  // bridge_required — file is in Claude's sandbox; MCP server cannot read it
  REQUIRED_ACTION?: string;
  mac_path_hint?: string;
  // error fields
  error?: string;
  hint?: string;
}

// ── Handler ───────────────────────────────────────────────────────────────

const UPLOAD_SCOPES = [
  "data:read",
  "data:write",
  "data:create",
  "bucket:create",
  "bucket:read",
  "bucket:update",
];

function normalizePath(raw: string): string {
  let p = raw.trim().replace(/^['"]|['"]$/g, "");
  if (p.startsWith("~/") || p === "~") p = homedir() + p.slice(1);
  return p;
}

// Paths only accessible inside Claude's bash sandbox, not by the Mac MCP process
function isSandboxPath(p: string): boolean {
  return p.startsWith("/mnt/user-data/") || p.startsWith("/mnt/");
}

export async function handleUploadFile(input: UploadFileInput): Promise<UploadFileResult> {
  const resolvedPath = normalizePath(input.file_path);
  const filename = basename(resolvedPath);
  const contentType = detectContentType(filename);

  // ── Sandbox check (before auth) ───────────────────────────────────────────
  // MCP server (Mac) cannot read /mnt/ paths; they exist only in Claude's sandbox.
  if (isSandboxPath(resolvedPath)) {
    const macPath = `~/Downloads/${filename}`;
    return {
      status: "bridge_required",
      mac_path_hint: macPath,
      REQUIRED_ACTION:
        `File '${filename}' is a chat attachment — the MCP server cannot read it directly. ` +
        `Please provide the file's actual path on your Mac (e.g. ~/Downloads/${filename}, a OneDrive path, or any local folder), ` +
        `then call upload_file again with that path.`,
    };
  }

  // ── File existence check ──────────────────────────────────────────────────
  if (!existsSync(resolvedPath)) {
    return {
      status: "error",
      error: `File not found: '${resolvedPath}'`,
      hint: `Check the path is correct and the file exists on this Mac. ` +
        `If the file was attached to the chat rather than saved locally, save it to ~/Downloads/ first.`,
    };
  }

  // ── APS auth ──────────────────────────────────────────────────────────────
  let cred: { client_id: string; access_token: string };
  try {
    cred = await resolveCredential(UPLOAD_SCOPES);
  } catch (err) {
    return {
      status: "error",
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first to configure credentials.",
    };
  }

  const bucketKey = sanitizeBucketKey(input.bucket_key ?? `${cred.client_id}-uploads`);
  const objectKey = input.object_key ?? filename;

  // ── Resolve file content ─────────────────────────────────────────────────
  let fileBuffer: Buffer;
  let fileSizeBytes: number;

  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    return { status: "error", error: `Path is not a file: '${resolvedPath}'` };
  }
  const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
  if (stat.size > MAX_UPLOAD_BYTES) {
    return {
      status: "error",
      error: `File too large: ${(stat.size / 1024 / 1024).toFixed(0)} MB. Maximum supported upload size is 500 MB.`,
      hint: "Split the file or use the APS Data Management API multipart upload for files over 500 MB.",
    };
  }
  try {
    fileBuffer = readFileSync(resolvedPath);
  } catch (err) {
    return { status: "error", error: `Could not read file: ${String(err)}` };
  }
  fileSizeBytes = stat.size;

  try {
    await ensureBucketWithPolicy(cred.access_token, bucketKey, input.bucket_policy);
  } catch (err) {
    return {
      status: "error",
      error: `Could not ensure bucket '${bucketKey}': ${String(err)}`,
      hint: "Bucket keys must be 3–128 chars, lowercase letters, numbers, and hyphens only.",
    };
  }

  // APS OSS Direct-to-S3: single-part PUT is limited to 5 MB.
  // For larger files, request one signed URL per 5 MB chunk.
  const PART_SIZE = 5 * 1024 * 1024;
  const numParts = Math.max(1, Math.ceil(fileSizeBytes / PART_SIZE));

  let signedUpload: { uploadKey: string; urls: string[] };
  try {
    signedUpload = await getSignedS3UploadUrl(
      cred.access_token,
      bucketKey,
      objectKey,
      input.signed_url_expiry_minutes,
      numParts
    );
  } catch (err) {
    return { status: "error", error: `Could not get upload URL: ${String(err)}` };
  }

  if (!signedUpload.urls?.length) {
    return { status: "error", error: "OSS returned no upload URL." };
  }

  try {
    for (let i = 0; i < numParts; i++) {
      const chunk = fileBuffer.slice(i * PART_SIZE, (i + 1) * PART_SIZE) as Buffer;
      await uploadToS3(signedUpload.urls[i], chunk, contentType);
    }
  } catch (err) {
    return { status: "error", error: `S3 upload failed: ${String(err)}` };
  }

  try {
    await finalizeS3Upload(cred.access_token, bucketKey, objectKey, signedUpload.uploadKey);
  } catch (err) {
    return { status: "error", error: `Finalize upload failed: ${String(err)}` };
  }

  const ossUrl = `oss://${bucketKey}/${objectKey}`;
  let signedDownloadUrl: string | undefined;
  try {
    signedDownloadUrl = await getSignedDownloadUrl(cred.access_token, ossUrl);
  } catch {
    // Non-fatal
  }

  return {
    status: "success",
    oss_url: ossUrl,
    signed_download_url: signedDownloadUrl,
    bucket_key: bucketKey,
    object_key: objectKey,
    file_size_bytes: fileSizeBytes,
    content_type: contentType,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sanitizeBucketKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
    .padEnd(3, "0");
}

async function ensureBucketWithPolicy(
  token: string,
  bucketKey: string,
  policy: "transient" | "temporary" | "persistent"
): Promise<void> {
  const OSS_BASE = "https://developer.api.autodesk.com/oss/v2";

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
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketKey, policyKey: policy }),
  });

  if (!create.ok) {
    const body = await create.text();
    throw new DAError(`Create bucket failed: ${body}`, create.status);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".rvt": "application/octet-stream",
  ".rfa": "application/octet-stream",
  ".dwg": "application/acad",
  ".dxf": "application/dxf",
  ".ipt": "application/octet-stream",
  ".iam": "application/octet-stream",
  ".idw": "application/octet-stream",
  ".ipn": "application/octet-stream",
  ".f3d": "application/octet-stream",
  ".f3z": "application/zip",
  ".nwd": "application/octet-stream",
  ".nwc": "application/octet-stream",
  ".ifc": "application/x-step",
  ".obj": "text/plain",
  ".fbx": "application/octet-stream",
  ".step": "application/x-step",
  ".stp": "application/x-step",
  ".stl": "application/octet-stream",
  ".3dm": "application/octet-stream",
  ".max": "application/octet-stream",
  ".zip": "application/zip",
  ".json": "application/json",
  ".pdf": "application/pdf",
};

function detectContentType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
