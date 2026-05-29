import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { resolveCredential, DEFAULT_SCOPES } from "../auth/credential-resolver.js";
import { DAError, getSignedS3DownloadUrl } from "../lib/da-client.js";
import { handleRecordTokenUsage } from "./record-token-usage.js";

export const getResultSchema = z.object({
  oss_url: z
    .string()
    .describe(
      "The oss:// URL of the output file returned by execute_workflow (e.g. oss://bucket/key.json). " +
        "The MCP server (Mac process) fetches this via APS + S3 APIs — Claude's bash is NOT involved and is NOT needed."
    ),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(50_000)
    .optional()
    .default(50_000)
    .describe(
      "Maximum characters to return per call. Default and max: 50 000. " +
        "For large files use offset_chars to paginate: call repeatedly incrementing offset_chars by max_chars until has_more=false."
    ),
  offset_chars: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe(
      "Character offset to start reading from. Default: 0. " +
        "Use with max_chars to page through large files: offset_chars=0, then 50000, 100000, etc. " +
        "The response includes total_chars and has_more to guide pagination."
    ),
  force_text: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Force UTF-8 text decoding even if content-type and sniffing suggest binary. " +
        "Use when you know the file is text (e.g. a .json output stored with application/octet-stream) " +
        "and the automatic detection is wrong."
    ),
  is_last_output: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Set to false when more get_result calls follow for this workflow (multi-output jobs). " +
        "Default true: token usage is auto-recorded when model + estimated tokens are also provided."
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Your model ID (e.g. 'claude-sonnet-4-6'). Provide with estimated_input_tokens and " +
        "estimated_output_tokens when is_last_output=true to auto-record token usage inline — " +
        "no separate record_token_usage call needed."
    ),
  estimated_input_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Estimated total session input tokens. Provide when is_last_output=true."),
  estimated_output_tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Estimated total session output tokens. Provide when is_last_output=true."),
  save_to: z
    .string()
    .optional()
    .describe(
      "Local folder path to save the downloaded file (e.g. ~/Downloads or /Users/you/outputs). " +
        "When provided, the full file is downloaded and written to <save_to>/<filename>. " +
        "The folder is created if it does not exist. ~ is expanded to the home directory. " +
        "The saved_to field in the response contains the resolved file path. " +
        "For binary files (PDF, ZIP, RVT, DWG, images), this is the recommended way to retrieve " +
        "the output — binary content cannot be displayed as text."
    ),
  save_filename: z
    .string()
    .optional()
    .describe(
      "Override the filename used when saving (requires save_to). " +
        "Use when the OSS object key has a misleading name (e.g. 'result.json' that is actually a PDF). " +
        "Example: 'sampledwg_converted.pdf'. If omitted, the filename is taken from the OSS object key."
    ),
});

export type GetResultInput = z.infer<typeof getResultSchema>;

export interface GetResultOutput {
  status: "success" | "error";
  oss_url?: string;
  content_type?: string;
  detected_as?: string;       // "json" | "csv" | "xml" | "text" | "binary"
  size_bytes?: number;
  total_chars?: number;       // total decoded text length (text files only)
  content?: string;
  offset_chars?: number;      // offset this chunk starts at
  has_more?: boolean;         // true if more content exists after this chunk
  next_offset?: number;       // offset to pass in the next call (offset_chars + len(content))
  truncated?: boolean;        // kept for back-compat; same as has_more for first call
  binary?: boolean;
  saved_to?: string;          // resolved local path where the file was saved (when save_to was provided)
  next_action?: string;       // present on final output only — instructs LLM to output summary_line
  summary_line?: string;      // token usage summary — output verbatim as last line of response
  error?: string;
  hint?: string;
}

// ── Content detection ─────────────────────────────────────────────────────
// APS Design Automation always stores outputs as application/octet-stream regardless
// of actual content type. We cannot trust the Content-Type header. Instead:
//   1. Trust the file extension (most reliable — DA jobs produce named outputs)
//   2. Check for known binary magic bytes
//   3. Sample the first 512 bytes: >2% control characters → binary

const TEXT_EXTENSIONS = new Set([
  "json", "csv", "xml", "txt", "html", "htm", "yaml", "yml",
  "log", "md", "tsv", "svg", "geojson", "ndjson",
]);

const BINARY_MAGIC: number[][] = [
  [0x25, 0x50, 0x44, 0x46],       // PDF: %PDF
  [0x89, 0x50, 0x4E, 0x47],       // PNG
  [0xFF, 0xD8, 0xFF],              // JPEG
  [0x47, 0x49, 0x46],              // GIF
  [0x50, 0x4B, 0x03, 0x04],       // ZIP / DOCX / XLSX / F3Z
  [0x50, 0x4B, 0x05, 0x06],       // ZIP empty
  [0x1F, 0x8B],                    // GZIP / NWD / NWC
  [0xD0, 0xCF, 0x11, 0xE0],       // OLE compound (RVT, DWG ≤2003)
  [0x7F, 0x45, 0x4C, 0x46],       // ELF binary
  [0x42, 0x4D],                    // BMP
  [0x00, 0x01, 0x00, 0x00],       // TrueType font / ICO
];

type Detected = "json" | "csv" | "xml" | "text" | "binary";

function detectContent(bytes: Uint8Array, objectKey: string): Detected {
  if (bytes.length === 0) return "text";

  // 1. Binary magic bytes — highest priority, overrides extension.
  // APS DA often stores PDFs with a .json object key; magic bytes are authoritative.
  for (const sig of BINARY_MAGIC) {
    if (sig.every((b, i) => bytes[i] === b)) return "binary";
  }

  // 2. Extension check for text subtype classification
  const ext = (objectKey.split(".").pop() ?? "").toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    if (ext === "json") return "json";
    if (ext === "csv" || ext === "tsv") return "csv";
    if (ext === "xml" || ext === "svg") return "xml";
    return "text";
  }

  // 3. Sample 512 bytes for control characters
  const sample = bytes.slice(0, Math.min(512, bytes.length));
  let control = 0;
  for (const b of sample) {
    // Allow: HT(9) LF(10) CR(13) printable ASCII(32-126) UTF-8 high(128+)
    if (b < 9 || (b > 13 && b < 32) || b === 127) control++;
  }
  if (control / sample.length > 0.02) return "binary";

  // 4. Peek at first printable character to classify text subtype
  const head = String.fromCharCode(...sample.slice(0, 3));
  if (head.trimStart().startsWith("{") || head.trimStart().startsWith("[")) return "json";
  if (head.trimStart().startsWith("<")) return "xml";

  // CSV heuristic: has comma/tab and a newline in the first sample
  const sampleStr = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  if ((sampleStr.includes(",") || sampleStr.includes("\t")) && sampleStr.includes("\n")) return "csv";

  return "text";
}

// ── File save helper ──────────────────────────────────────────────────────

function resolveSavePath(folder: string, filename: string): string {
  const expanded = folder.startsWith("~")
    ? path.join(os.homedir(), folder.slice(1))
    : folder;
  const resolved = path.resolve(expanded);
  fs.mkdirSync(resolved, { recursive: true });
  return path.join(resolved, filename);
}

// Auto-records token usage inline when the LLM passes model + token estimates to get_result.
// Returns summary_line on success, undefined if params missing or recording fails.
async function tryAutoRecordTokens(input: GetResultInput): Promise<string | undefined> {
  if (input.is_last_output === false) return undefined;
  if (!input.model || !input.estimated_input_tokens || !input.estimated_output_tokens) return undefined;
  try {
    const result = await handleRecordTokenUsage({
      model: input.model,
      input_tokens: input.estimated_input_tokens,
      output_tokens: input.estimated_output_tokens,
    });
    return result.summary_line;
  } catch {
    return undefined;
  }
}

// ── Handler ───────────────────────────────────────────────────────────────

export async function handleGetResult(input: GetResultInput): Promise<GetResultOutput> {
  const withoutScheme = input.oss_url.replace(/^oss:\/\//, "");
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) {
    return {
      status: "error",
      error: `Invalid oss:// URL: '${input.oss_url}'. Expected format: oss://bucketKey/objectKey`,
    };
  }
  const bucketKey = withoutScheme.slice(0, slash);
  const objectKey = withoutScheme.slice(slash + 1);

  // ── Auth ──────────────────────────────────────────────────────────────────
  let token: string;
  try {
    const cred = await resolveCredential(DEFAULT_SCOPES);
    token = cred.access_token;
  } catch (err) {
    return {
      status: "error",
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first.",
    };
  }

  // ── Step 1: Get presigned S3 download URL via APS API ────────────────────
  // The MCP server (Mac process) calls developer.api.autodesk.com directly.
  // Claude's bash is NOT used here and cannot be — the Autodesk API and S3
  // are not in Claude's bash network allowlist.
  let signedUrl: string;
  try {
    signedUrl = await getSignedS3DownloadUrl(token, input.oss_url);
  } catch (err) {
    if (err instanceof DAError && err.statusCode === 404) {
      return {
        status: "error",
        oss_url: input.oss_url,
        error: `Object not found: ${bucketKey}/${objectKey}`,
        hint: "Transient buckets auto-delete after 24 h. WorkItem may not have finished yet.",
      };
    }
    return {
      status: "error",
      oss_url: input.oss_url,
      error: `Could not get download URL: ${String(err)}`,
    };
  }

  // ── save_to path: one S3 fetch does everything ───────────────────────────
  // Full fetch → save to disk → detect from in-memory bytes → return.
  // No range fetch needed — avoids the previous 2-fetch pattern.
  if (input.save_to) {
    const filename = input.save_filename ?? (objectKey.split("/").pop() ?? objectKey);
    const saveController = new AbortController();
    const saveTimer = setTimeout(() => saveController.abort(), 120_000);
    let saveRes: Response;
    try {
      saveRes = await fetch(signedUrl, { signal: saveController.signal });
    } catch (err) {
      return { status: "error", error: `Network error downloading file: ${String(err)}` };
    } finally {
      clearTimeout(saveTimer);
    }
    if (!saveRes.ok) {
      const body = await saveRes.text().catch(() => "");
      return {
        status: "error",
        oss_url: input.oss_url,
        error: `S3 download failed (HTTP ${saveRes.status}): ${body.slice(0, 500)}`,
      };
    }

    let fullBytes: Uint8Array;
    try {
      fullBytes = new Uint8Array(await saveRes.arrayBuffer());
    } catch (err) {
      return { status: "error", oss_url: input.oss_url, error: `Failed to read response body: ${String(err)}` };
    }

    let savedTo: string;
    try {
      savedTo = resolveSavePath(input.save_to, filename);
      fs.writeFileSync(savedTo, fullBytes);
    } catch (err) {
      return {
        status: "error",
        oss_url: input.oss_url,
        error: `Failed to save file: ${String(err)}`,
        hint: `Check that the folder path '${input.save_to}' is writable.`,
      };
    }

    // Detect from the already-fetched bytes — no second S3 call needed.
    let detected = detectContent(fullBytes.slice(0, 512), objectKey);
    if (input.force_text && detected === "binary") {
      const head = String.fromCharCode(...fullBytes.slice(0, 3));
      const sampleStr = new TextDecoder("utf-8", { fatal: false }).decode(fullBytes.slice(0, 512));
      if (head.trimStart().startsWith("{") || head.trimStart().startsWith("[")) detected = "json";
      else if (head.trimStart().startsWith("<")) detected = "xml";
      else if ((sampleStr.includes(",") || sampleStr.includes("\t")) && sampleStr.includes("\n")) detected = "csv";
      else detected = "text";
    }

    if (detected === "binary") {
      const summaryLine = await tryAutoRecordTokens(input);
      return {
        status: "success",
        oss_url: input.oss_url,
        content_type: "application/octet-stream",
        detected_as: "binary",
        size_bytes: fullBytes.byteLength,
        binary: true,
        content: `[Binary file — ${fullBytes.byteLength.toLocaleString()} bytes. Saved to: ${savedTo}]`,
        saved_to: savedTo,
        truncated: false,
        summary_line: summaryLine,
        next_action: summaryLine ? `Output the summary_line field verbatim as the LAST line of your response.` : undefined,
      };
    }

    // Text: extract content window directly from in-memory bytes.
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(fullBytes);
    const windowText = raw.slice(input.offset_chars, input.offset_chars + input.max_chars);
    const hasMoreText = input.offset_chars + windowText.length < raw.length;
    const summaryLineText = !hasMoreText ? await tryAutoRecordTokens(input) : undefined;
    return {
      status: "success",
      oss_url: input.oss_url,
      content_type: "application/octet-stream",
      detected_as: detected,
      size_bytes: fullBytes.byteLength,
      total_chars: raw.length,
      content: windowText,
      offset_chars: input.offset_chars,
      has_more: hasMoreText,
      next_offset: hasMoreText ? input.offset_chars + new TextEncoder().encode(windowText).byteLength : undefined,
      truncated: hasMoreText,
      binary: false,
      saved_to: savedTo,
      summary_line: summaryLineText,
      next_action: summaryLineText ? `Output the summary_line field verbatim as the LAST line of your response.` : undefined,
    };
  }

  // ── No save_to: range fetch for detection + text content ──────────────────
  // Requests enough bytes for both binary detection (512 B) and a full text window
  // (max_chars chars × 4 bytes/char worst-case for UTF-8).
  const startByte = input.offset_chars;
  const endByte = startByte + input.max_chars * 4 + 512 - 1;

  let res: Response;
  const rangeController = new AbortController();
  const rangeTimer = setTimeout(() => rangeController.abort(), 30_000);
  try {
    res = await fetch(signedUrl, {
      headers: { Range: `bytes=${startByte}-${endByte}` },
      signal: rangeController.signal,
    });
  } catch (err) {
    return { status: "error", error: `Network error fetching from S3: ${String(err)}` };
  } finally {
    clearTimeout(rangeTimer);
  }

  // S3 returns 206 for partial content, 200 if the file fits within the range.
  if (res.status !== 206 && res.status !== 200) {
    const body = await res.text().catch(() => "");
    return {
      status: "error",
      oss_url: input.oss_url,
      error: `S3 download failed (HTTP ${res.status}): ${body.slice(0, 500)}`,
    };
  }

  const contentTypeHeader = res.headers.get("content-type") ?? "application/octet-stream";

  // Content-Range: bytes 0-49999/2029983 → total = 2029983
  let totalBytes: number | undefined;
  const contentRangeHeader = res.headers.get("content-range");
  if (contentRangeHeader) {
    const m = contentRangeHeader.match(/\/(\d+)$/);
    if (m) totalBytes = parseInt(m[1], 10);
  }
  if (!totalBytes) {
    const cl = parseInt(res.headers.get("content-length") ?? "0", 10);
    if (cl > 0) totalBytes = startByte + cl;
  }

  const ab = await res.arrayBuffer();
  const bytes = new Uint8Array(ab);
  const sizeBytes = totalBytes ?? (startByte + bytes.byteLength);

  let detected = detectContent(bytes, objectKey);
  if (input.force_text && detected === "binary") {
    const head = String.fromCharCode(...bytes.slice(0, 3));
    const sampleStr = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512));
    if (head.trimStart().startsWith("{") || head.trimStart().startsWith("[")) detected = "json";
    else if (head.trimStart().startsWith("<")) detected = "xml";
    else if ((sampleStr.includes(",") || sampleStr.includes("\t")) && sampleStr.includes("\n")) detected = "csv";
    else detected = "text";
  }

  if (detected === "binary") {
    let savedTo: string | undefined;
    const autoFilename = input.save_filename ?? (objectKey.split("/").pop() ?? objectKey);
    try {
      let fullBytes: Uint8Array;
      if (res.status === 200) {
        // Range request returned the full file — reuse bytes, no second fetch needed.
        fullBytes = bytes;
      } else {
        // File is larger than the range window — fetch the full file for saving.
        // 45s keeps total get_result call well under MCP transport timeout (~60s).
        const fullController = new AbortController();
        const fullTimer = setTimeout(() => fullController.abort(), 45_000);
        let fullRes: Response;
        try {
          fullRes = await fetch(signedUrl, { signal: fullController.signal });
        } finally {
          clearTimeout(fullTimer);
        }
        if (!fullRes.ok) throw new Error(`HTTP ${fullRes.status}`);
        fullBytes = new Uint8Array(await fullRes.arrayBuffer());
      }
      savedTo = resolveSavePath(os.homedir() + "/Downloads", autoFilename);
      fs.writeFileSync(savedTo, fullBytes);
    } catch {
      // Auto-save failed — fall through to hint message
    }

    const binaryContent = savedTo
      ? `[Binary file — ${sizeBytes.toLocaleString()} bytes. Auto-saved to: ${savedTo}]`
      : `[Binary file — ${sizeBytes.toLocaleString()} bytes. ` +
        `Could not auto-save. Pass save_to="~/Downloads" to download it.]`;
    const summaryLineBin = await tryAutoRecordTokens(input);
    return {
      status: "success",
      oss_url: input.oss_url,
      content_type: contentTypeHeader,
      detected_as: "binary",
      size_bytes: sizeBytes,
      binary: true,
      content: binaryContent,
      saved_to: savedTo,
      truncated: false,
      summary_line: summaryLineBin,
      next_action: summaryLineBin ? `Output the summary_line field verbatim as the LAST line of your response.` : undefined,
    };
  }

  // ── Text: decode the fetched slice, extract the content window ────────────
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const window = raw.slice(0, input.max_chars);
  const windowByteLength = new TextEncoder().encode(window).byteLength;

  const totalChars = totalBytes ?? sizeBytes;
  const hasMore = startByte + windowByteLength < totalChars;
  const summaryLineTxt = !hasMore ? await tryAutoRecordTokens(input) : undefined;

  return {
    status: "success",
    oss_url: input.oss_url,
    content_type: contentTypeHeader,
    detected_as: detected,
    size_bytes: sizeBytes,
    total_chars: totalChars,
    content: window,
    offset_chars: startByte,
    has_more: hasMore,
    next_offset: hasMore ? startByte + windowByteLength : undefined,
    truncated: hasMore,
    binary: false,
    saved_to: undefined,
    summary_line: summaryLineTxt,
    next_action: summaryLineTxt ? `Output the summary_line field verbatim as the LAST line of your response.` : undefined,
  };
}
