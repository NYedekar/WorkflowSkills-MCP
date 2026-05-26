import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createWorkflowSchema, handleCreateWorkflow, } from "./tools/create-workflow.js";
import { exportWorkflowSchema, handleExportWorkflow, } from "./tools/export-workflow.js";
import { authenticateApsSchema, handleAuthenticateAps, } from "./tools/authenticate-aps.js";
import { getCapabilitySchema, handleGetCapability, } from "./tools/get-capability.js";
import { executeWorkflowSchema, handleExecuteWorkflow, } from "./tools/execute-workflow.js";
import { uploadFileSchema, handleUploadFile, } from "./tools/upload-file.js";
import { getResultSchema, handleGetResult, } from "./tools/get-result.js";
import { processFileSchema, handleProcessFile, } from "./tools/process-file.js";
import { getWorkflowStatusSchema, handleGetWorkflowStatus, } from "./tools/get-workflow-status.js";
import { getDownloadLinkSchema, handleGetDownloadLink, } from "./tools/get-download-link.js";
import { saveToMacSchema, handleSaveToMac, } from "./tools/save-to-mac.js";
// ─── Server setup ─────────────────────────────────────────────────────────
const server = new Server({
    name: "mcp-workflow-builder",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
    instructions: "=== WorkflowSkills MCP ===\n\n" +
        "MANDATORY TRIGGER — call get_capability as your VERY FIRST action (before any response, any reasoning, any bash, any Python) when ANY of these file extensions appear anywhere in the conversation — attached, typed as a path, or mentioned by name:\n\n" +
        "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
        "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX " +
        "NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL\n\n" +
        "These are Autodesk proprietary formats. DO NOT attempt to read, parse, or process them using Python, bash, olefile, rvt-meta, or any local library — they require APS cloud services and will fail or produce wrong results locally.\n\n" +
        "── TOOL SELECTION ───────────────────────────────────────────────────────\n\n" +
        "Use this decision tree every time before picking a tool:\n\n" +
        "1. Single intent + local file?\n" +
        "   → process_file  (fast path: upload + run + return results in one call. No planning needed.)\n\n" +
        "2. Multiple intents + local file?\n" +
        "   → create_workflow(file_path=..., intents=[...])  — uploads the file ONCE, builds the DAG, returns oss_url.\n" +
        "   → Then execute_workflow(input_file_url=oss_url, ...) for each step in the DAG.\n" +
        "   NEVER call process_file multiple times for the same file — it re-uploads each time.\n\n" +
        "3. File already in APS OSS (you have an oss:// URL)?\n" +
        "   → execute_workflow directly — no upload needed.\n\n" +
        "4. No file, just an APS REST operation or info question?\n" +
        "   → execute_workflow for REST calls. Answer from knowledge for pure info.\n\n" +
        "── STANDARD FLOW ────────────────────────────────────────────────────────\n\n" +
        "Step 1 — get_capability(query='<ext> <intent>') — present results; confirm with user.\n" +
        "Step 2 — authenticate_aps() — ALWAYS before any upload or execution.\n" +
        "         • error → stop. Show error. Ask user to check APS credentials.\n" +
        "Step 3 — Execute using the tool selected above (process_file or create_workflow + execute_workflow).\n\n" +
        "── STATUS HANDLING (process_file and execute_workflow) ──────────────────\n\n" +
        "• success         → present outputs. Done.\n" +
        "• pending         → WorkItem still running. Call get_workflow_status(workflow_handle). Repeat until success or failed.\n" +
        "• bridge_required → show REQUIRED_ACTION verbatim. Ask for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path.\n" +
        "• no_capability_found → show gap_note. Answer from knowledge.\n" +
        "• error           → show error + hint.\n\n" +
        "── RULES ────────────────────────────────────────────────────────────────\n\n" +
        "NETWORK: bash cannot reach Autodesk, S3, or localhost (blocked by Claude Desktop proxy). The MCP server (Mac process) handles all network calls. ALWAYS use get_result to read output files — never curl/wget.\n" +
        "PIPELINES: always render the ASCII diagram from create_workflow verbatim in a fenced code block.\n" +
        "PURE INFO (no file, no operation): answer directly — do not call any tool.\n\n" +
        "── FILE DOWNLOAD ────────────────────────────────────────────────────────\n\n" +
        "After any successful operation that produces an output file, call get_download_link(oss_url=...) " +
        "and render the returned markdown_link directly in your response so the user can click to download. " +
        "Always pass a clean filename via the filename param (e.g. 'drawing.pdf', not the full OSS key). " +
        "Links expire in ~1 hour — note this to the user.\n\n" +
        "── SAVING DATA TO MAC ───────────────────────────────────────────────────\n\n" +
        "CRITICAL: Claude's bash environment is sandboxed — it CANNOT write files to the Mac filesystem. " +
        "cp, mv, tee, write, or any bash file-write to /Users/... will FAIL silently or with permission errors. " +
        "To save any content (JSON, CSV, Markdown, aggregated results) to the Mac, ALWAYS use save_to_mac. " +
        "This includes: assembled metadata, summarized property dumps, multi-call aggregations, any synthesized output. " +
        "Never attempt bash file writes to Mac paths.",
});
// ─── Tool list ────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "create_workflow",
                description: "Use when the user's request has MULTIPLE intents for an Autodesk file or pipeline. " +
                    "Decomposes the request into a DAG of steps (sequential, parallel, conditional, loop), plans execution order, and renders an ASCII pipeline diagram. " +
                    "Accepts an optional file_path — when provided, uploads the file to APS OSS ONCE and returns oss_url alongside the DAG. " +
                    "Pass that oss_url to every subsequent execute_workflow call so all steps share the same upload. " +
                    "Does NOT execute any steps — use execute_workflow to run each node in the DAG after reviewing the plan. " +
                    "Returns: (1) ASCII diagram — render it verbatim in a fenced code block; (2) JSON DAG; (3) oss_url if a file was provided. " +
                    "STATUS FLOW for the file upload: bridge_required → show REQUIRED_ACTION verbatim and ask for the file's actual Mac path; error → show error + hint.",
                inputSchema: zodToJsonSchema(createWorkflowSchema),
            },
            {
                name: "export_workflow",
                description: "Serialize a workflow DAG to JSON or YAML, optionally saving to a file.",
                inputSchema: zodToJsonSchema(exportWorkflowSchema),
            },
            {
                name: "authenticate_aps",
                description: "Verify APS credentials and cache the token. Reads APS_CLIENT_ID and APS_CLIENT_SECRET from the MCP process env — never from tool params. Call once to confirm the connection is healthy. " +
                    "Note: each distinct set of OAuth scopes produces a separately cached token; if you request a scope set that differs from a previous call, a new token is fetched and cached independently.",
                inputSchema: zodToJsonSchema(authenticateApsSchema),
            },
            {
                name: "get_capability",
                description: "REQUIRED first call whenever any of these file extensions appear in the conversation: " +
                    "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
                    "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX " +
                    "NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL. " +
                    "Also call when any Autodesk cloud service is referenced (ACC, BIM 360, Autodesk Docs, Fusion Hub, Vault, APS OSS, ShotGrid, Tandem, Forma, ReCap Cloud). " +
                    "Searches 260+ capabilities across Design Automation (Engine-API) and APS REST (Platform-API). " +
                    "Returns capability_id and operation_id for process_file. No results = Coverage Gap — do not attempt local fallback. " +
                    "Filter by query, capability_id, operation_id, or risk. Use query for natural language search.",
                inputSchema: zodToJsonSchema(getCapabilitySchema),
            },
            {
                name: "upload_file",
                description: "Upload a file to APS OSS. Pass the file's actual Mac path — local folder, ~/Downloads/, or OneDrive (~/Library/CloudStorage/OneDrive-Autodesk/…). " +
                    "Returns status='success' with oss_url when the MCP server can read the file. " +
                    "Returns status='bridge_required' when the file is a chat attachment — show REQUIRED_ACTION to user and ask for the file's actual Mac path. " +
                    "Returns an oss:// URL for execute_workflow.",
                inputSchema: zodToJsonSchema(uploadFileSchema),
            },
            {
                name: "execute_workflow",
                description: "Run a SINGLE APS capability operation: Engine-API (DA WorkItem → polls → outputOssUrl) or Platform-API (REST call → response). " +
                    "Use this to run each step of a multi-intent pipeline after create_workflow has planned the DAG. " +
                    "Also use directly when the file is already in APS OSS (you have an oss:// URL) and you know the capability + operation. " +
                    "Call get_capability first for capability_id+operation_id. " +
                    "For local files with a single step, prefer process_file instead — it handles upload automatically. " +
                    "For local files with multiple steps, use create_workflow(file_path=...) to upload once and get oss_url, then call execute_workflow per step. " +
                    "After execution, call get_result with outputOssUrl to read the primary output. " +
                    "Multi-output operations return outputOssUrls[] — call get_result on each entry.",
                inputSchema: zodToJsonSchema(executeWorkflowSchema),
            },
            {
                name: "get_result",
                description: "Fetch output file content from APS OSS after execute_workflow or process_file completes. " +
                    "NETWORK ARCHITECTURE: the MCP server (Mac process with unrestricted network) calls the APS API and S3 directly — " +
                    "Claude's bash is NOT used and CANNOT be used (Autodesk and S3 domains are not in bash's network allowlist). " +
                    "ALWAYS call this tool to read output files — never attempt curl or wget from bash. " +
                    "Content-type detection uses byte-level content sniffing so JSON/CSV outputs stored as application/octet-stream are returned as text, not flagged as binary. " +
                    "The detected_as field tells you the actual format: json | csv | xml | text | binary. " +
                    "LARGE FILES: max_chars is capped at 50 000 per call. When has_more=true, call again with offset_chars=next_offset to fetch the next chunk. " +
                    "Repeat until has_more=false. total_chars tells you the full file size upfront. " +
                    "SAVING FILES: pass save_to with a local folder path to download and save the full file to disk. " +
                    "If the user says 'download', 'save', or 'export the file' without specifying a folder, default to ~/Downloads. " +
                    "The saved_to field in the response contains the resolved path. " +
                    "For binary outputs (PDF, DWG, RVT, ZIP, images), save_to is the recommended way to retrieve them — binary content cannot be displayed as text. " +
                    "APS DA often stores PDF outputs with a .json object key — use save_filename to give the saved file the correct name and extension (e.g. save_filename='drawing.pdf').",
                inputSchema: zodToJsonSchema(getResultSchema),
            },
            {
                name: "process_file",
                description: "Fast path for a SINGLE intent + local file: auto-selects capability, uploads, runs, and returns all output in one call. " +
                    "Use ONLY when the user has exactly one thing to do with a local file. " +
                    "For multiple intents on the same file, use create_workflow(file_path=...) instead — it uploads once and shares the oss_url across all steps. " +
                    "Do NOT call process_file in a loop for the same file — it re-uploads on every call. " +
                    "STATUS FLOW: " +
                    "• success → present outputs. Done. " +
                    "• pending → WorkItem still running. Call get_workflow_status(workflow_handle). Repeat until success or failed. " +
                    "• bridge_required → file is a chat attachment; MCP server cannot read it. Show REQUIRED_ACTION verbatim. Ask user for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path. " +
                    "• no_capability_found → show gap_note. Answer from knowledge. " +
                    "• error → show error + hint.",
                inputSchema: zodToJsonSchema(processFileSchema),
            },
            {
                name: "get_workflow_status",
                description: "Poll the status of a running Autodesk workflow (DA WorkItem or future async job types). " +
                    "Call this after execute_workflow or process_file returns status='pending'. " +
                    "Pass the workflow_handle exactly as received — do not modify it. " +
                    "Polls for up to 50s per call (safe under MCP transport timeout). " +
                    "STATUS FLOW: " +
                    "• pending → still running. Call again with the same workflow_handle. " +
                    "• success → job done. Call get_result on each outputOssUrls entry. " +
                    "• failed / cancelled → show error + reportUrl to user. " +
                    "Generic — handles DA WorkItems today, extensible to Model Derivative, ACC jobs, and other async APS operations.",
                inputSchema: zodToJsonSchema(getWorkflowStatusSchema),
            },
            {
                name: "save_to_mac",
                description: "Save text content (JSON, CSV, Markdown, plain text) directly to the Mac filesystem via the MCP server. " +
                    "CRITICAL: Claude's bash is sandboxed and CANNOT write to Mac disk (/Users/...). " +
                    "Use this tool whenever you need to save synthesized, aggregated, or assembled data to the Mac — " +
                    "e.g. metadata JSON built from multiple API calls, property summaries, extracted reports. " +
                    "Also use when execute_workflow auto-saves a large response and you want to save a processed/filtered version. " +
                    "Returns saved_to with the resolved file path on success.",
                inputSchema: zodToJsonSchema(saveToMacSchema),
            },
            {
                name: "get_download_link",
                description: "Generate a clickable HTTPS download link for any file in APS OSS. " +
                    "Call this after process_file, execute_workflow, or get_result completes to give the user a one-click download button. " +
                    "Returns markdown_link — render it directly in your response (e.g. '[⬇ Download drawing.pdf](https://...)') so the user can click it. " +
                    "Pass filename to give the link a clean display name instead of the raw OSS object key. " +
                    "The signed URL is valid for ~1 hour. " +
                    "WHEN TO CALL: automatically after every successful operation that produces a file output — do not wait for the user to ask.",
                inputSchema: zodToJsonSchema(getDownloadLinkSchema),
            },
        ],
    };
});
// ─── Tool call handler ────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "create_workflow": {
                const parsed = createWorkflowSchema.parse(args);
                const result = await handleCreateWorkflow(parsed);
                if (result.status === "bridge_required") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: true,
                    };
                }
                if (result.status === "error") {
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: true,
                    };
                }
                const parts = [
                    { type: "text", text: result.rendered },
                    { type: "text", text: JSON.stringify(result.dag, null, 2) },
                ];
                if (result.oss_url) {
                    parts.push({
                        type: "text",
                        text: `File uploaded. oss_url: ${result.oss_url} — pass this to each execute_workflow call as input_file_url.`,
                    });
                }
                return { content: parts };
            }
            case "export_workflow": {
                const parsed = exportWorkflowSchema.parse(args);
                const result = await handleExportWorkflow(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "authenticate_aps": {
                const parsed = authenticateApsSchema.parse(args);
                const result = await handleAuthenticateAps(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "upload_file": {
                const parsed = uploadFileSchema.parse(args);
                const result = await handleUploadFile(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "get_capability": {
                const parsed = getCapabilitySchema.parse(args);
                const result = await handleGetCapability(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            }
            case "execute_workflow": {
                const parsed = executeWorkflowSchema.parse(args);
                const result = await handleExecuteWorkflow(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error" || result.status === "failed" || result.status === "activity_not_found",
                };
            }
            case "get_result": {
                const parsed = getResultSchema.parse(args);
                const result = await handleGetResult(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "process_file": {
                const parsed = processFileSchema.parse(args);
                const result = await handleProcessFile(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error" || result.status === "failed",
                };
            }
            case "get_workflow_status": {
                const parsed = getWorkflowStatusSchema.parse(args);
                const result = await handleGetWorkflowStatus(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "failed" || result.status === "cancelled",
                };
            }
            case "get_download_link": {
                const parsed = getDownloadLinkSchema.parse(args);
                const result = await handleGetDownloadLink(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            case "save_to_mac": {
                const parsed = saveToMacSchema.parse(args);
                const result = await handleSaveToMac(parsed);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                    isError: result.status === "error",
                };
            }
            default:
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                        },
                    ],
                    isError: true,
                };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: message }),
                },
            ],
            isError: true,
        };
    }
});
// ─── Start server ─────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("mcp-workflow-builder server running on stdio");
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
