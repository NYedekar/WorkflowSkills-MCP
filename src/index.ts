import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  createWorkflowSchema,
  handleCreateWorkflow,
} from "./tools/create-workflow.js";
import {
  exportWorkflowSchema,
  handleExportWorkflow,
} from "./tools/export-workflow.js";
import {
  authenticateApsSchema,
  handleAuthenticateAps,
} from "./tools/authenticate-aps.js";
import {
  getCapabilitySchema,
  handleGetCapability,
} from "./tools/get-capability.js";
import {
  executeWorkflowSchema,
  handleExecuteWorkflow,
} from "./tools/execute-workflow.js";
import {
  uploadFileSchema,
  handleUploadFile,
} from "./tools/upload-file.js";
import {
  getResultSchema,
  handleGetResult,
} from "./tools/get-result.js";
import {
  processFileSchema,
  handleProcessFile,
} from "./tools/process-file.js";
import {
  getWorkflowStatusSchema,
  handleGetWorkflowStatus,
} from "./tools/get-workflow-status.js";

// ─── Server setup ─────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "mcp-workflow-builder",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "=== WorkflowSkills MCP ===\n\n" +

      "MANDATORY TRIGGER — call get_capability as your VERY FIRST action (before any response, any reasoning, any bash, any Python) when ANY of these file extensions appear anywhere in the conversation — attached, typed as a path, or mentioned by name:\n\n" +
      "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
      "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX " +
      "NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL\n\n" +

      "These are Autodesk proprietary formats. DO NOT attempt to read, parse, or process them using Python, bash, olefile, rvt-meta, or any local library — they require APS cloud services and will fail or produce wrong results locally.\n\n" +

      "FLOW:\n" +
      "1. get_capability(query='<ext> <user-intent>') — present results; ask user to confirm.\n" +
      "2. User confirms → call authenticate_aps() BEFORE anything else.\n" +
      "   • error → show error; do not proceed to process_file. Ask user to check APS credentials.\n" +
      "   • success → continue to step 3.\n" +
      "3. Call process_file(file_path, intent, capability_id, operation_id).\n" +
      "   • success → present outputs. Done.\n" +
      "   • pending → WorkItem running. Call get_workflow_status(workflow_handle). Repeat until success or failed.\n" +
      "   • bridge_required → show REQUIRED_ACTION to user verbatim. Ask for the file's actual Mac path (local folder, ~/Downloads/, or OneDrive). Retry process_file with that path.\n" +
      "   • no_capability_found → answer from knowledge + show gap_note.\n" +
      "   • error → show error + hint to user.\n" +
      "4. User declines → answer from knowledge.\n\n" +

      "NETWORK RULE: bash cannot reach Autodesk, S3, or localhost HTTP (all blocked by Claude Desktop proxy). The MCP server (Mac) can reach Autodesk/S3. ALWAYS use get_result to fetch output files — never curl/wget from bash.\n\n" +

      "PIPELINES: use create_workflow. Render ASCII diagram verbatim in a fenced code block.\n" +
      "PURE INFO (no file present, no operation): answer directly.",
  }
);

// ─── Tool list ────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "create_workflow",
        description:
          "Design a multi-step Autodesk automation pipeline as a DAG (fetch/transform/export/notify/trigger across Revit, ACC, APS, Model Derivative, etc.). " +
          "Returns two blocks: (1) ASCII diagram — reproduce it verbatim in a fenced code block; (2) JSON DAG.",
        inputSchema: zodToJsonSchema(createWorkflowSchema),
      },
      {
        name: "export_workflow",
        description: "Serialize a workflow DAG to JSON or YAML, optionally saving to a file.",
        inputSchema: zodToJsonSchema(exportWorkflowSchema),
      },
      {
        name: "authenticate_aps",
        description:
          "Verify APS credentials and cache the token. Reads APS_CLIENT_ID and APS_CLIENT_SECRET from the MCP process env — never from tool params. Call once to confirm the connection is healthy.",
        inputSchema: zodToJsonSchema(authenticateApsSchema),
      },
      {
        name: "get_capability",
        description:
          "REQUIRED first call whenever any of these file extensions appear in the conversation: " +
          "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
          "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX " +
          "NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL. " +
          "Also call when any Autodesk cloud service is referenced (ACC, BIM 360, Autodesk Docs, Fusion Hub, Vault, APS OSS, ShotGrid, Tandem, Forma, ReCap Cloud). " +
          "Searches 260+ capabilities across Design Automation (Engine-API) and APS REST (Platform-API). " +
          "Returns capability_id and operation_id for process_file. No results = Coverage Gap — do not attempt local fallback. " +
          "WARNING: Do NOT use the product filter param — it uses internal product ID strings that do not match common names like 'APS' or 'Model Derivative' and returns 0 results. Always search without a product filter.",
        inputSchema: zodToJsonSchema(getCapabilitySchema),
      },
      {
        name: "upload_file",
        description:
          "Upload a file to APS OSS. Pass the file's actual Mac path — local folder, ~/Downloads/, or OneDrive (~/Library/CloudStorage/OneDrive-Autodesk/…). " +
          "Returns status='success' with oss_url when the MCP server can read the file. " +
          "Returns status='bridge_required' when the file is a chat attachment — show REQUIRED_ACTION to user and ask for the file's actual Mac path. " +
          "Returns an oss:// URL for execute_workflow.",
        inputSchema: zodToJsonSchema(uploadFileSchema),
      },
      {
        name: "execute_workflow",
        description:
          "Run an APS capability: Engine-API (DA WorkItem → polls → outputOssUrl) or Platform-API (REST call → response). " +
          "Call get_capability first for capability_id+operation_id. For attached/local files, call upload_file first to get an oss_url. " +
          "After execution, call get_result with outputOssUrl to read the primary output. " +
          "Multi-output operations (e.g. RevitExtractor) return outputOssUrls[] — call get_result on each entry.",
        inputSchema: zodToJsonSchema(executeWorkflowSchema),
      },
      {
        name: "get_result",
        description:
          "Fetch output file content from APS OSS after execute_workflow or process_file completes. " +
          "NETWORK ARCHITECTURE: the MCP server (Mac process with unrestricted network) calls the APS API and S3 directly — " +
          "Claude's bash is NOT used and CANNOT be used (Autodesk and S3 domains are not in bash's network allowlist). " +
          "ALWAYS call this tool to read output files — never attempt curl or wget from bash. " +
          "Content-type detection uses byte-level content sniffing so JSON/CSV outputs stored as application/octet-stream are returned as text, not flagged as binary. " +
          "The detected_as field tells you the actual format: json | csv | xml | text | binary. " +
          "LARGE FILES: max_chars is capped at 50 000 per call. When has_more=true, call again with offset_chars=next_offset to fetch the next chunk. " +
          "Repeat until has_more=false. total_chars tells you the full file size upfront.",
        inputSchema: zodToJsonSchema(getResultSchema),
      },
      {
        name: "process_file",
        description:
          "Execute a complete Autodesk file workflow in one call: auto-selects capability from file type + intent, uploads, runs the DA WorkItem or REST operation, and returns all output content. " +
          "PRIMARY tool for single-file workflows — replaces upload_file → execute_workflow → get_result. " +
          "STATUS FLOW: " +
          "• success → present outputs. Done. " +
          "• pending → WorkItem is still running. Call get_workflow_status(workflow_handle) to continue polling. " +
          "• bridge_required → file is a chat attachment; MCP server cannot read it. Show REQUIRED_ACTION to user verbatim and wait for them to save it to ~/Downloads/. " +
          "• no_capability_found → show gap_note, answer from knowledge. " +
          "• error → show error + hint.",
        inputSchema: zodToJsonSchema(processFileSchema),
      },
      {
        name: "get_workflow_status",
        description:
          "Poll the status of a running Autodesk workflow (DA WorkItem or future async job types). " +
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
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }
        if (result.status === "error") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }
        const parts: { type: "text"; text: string }[] = [
          { type: "text" as const, text: result.rendered },
          { type: "text" as const, text: JSON.stringify(result.dag, null, 2) },
        ];
        if (result.oss_url) {
          parts.push({
            type: "text" as const,
            text: `File uploaded. oss_url: ${result.oss_url} — pass this to each execute_workflow call as input_file_url.`,
          });
        }
        return { content: parts };
      }
      case "export_workflow": {
        const parsed = exportWorkflowSchema.parse(args);
        const result = await handleExportWorkflow(parsed);
        return {
          content: [{ type: "text" as const, text: result }],
        };
      }
      case "authenticate_aps": {
        const parsed = authenticateApsSchema.parse(args);
        const result = await handleAuthenticateAps(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      case "upload_file": {
        const parsed = uploadFileSchema.parse(args);
        const result = await handleUploadFile(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      case "get_capability": {
        const parsed = getCapabilitySchema.parse(args);
        const result = await handleGetCapability(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      case "execute_workflow": {
        const parsed = executeWorkflowSchema.parse(args);
        const result = await handleExecuteWorkflow(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      case "get_result": {
        const parsed = getResultSchema.parse(args);
        const result = await handleGetResult(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      case "process_file": {
        const parsed = processFileSchema.parse(args);
        const result = await handleProcessFile(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      case "get_workflow_status": {
        const parsed = getWorkflowStatusSchema.parse(args);
        const result = await handleGetWorkflowStatus(parsed);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
      default:
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: message }),
        },
      ],
      isError: true,
    };
  }
});

// ─── Start server ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-workflow-builder server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
