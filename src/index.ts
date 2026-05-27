import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_INSTRUCTIONS = readFileSync(join(__dirname, "instructions.md"), "utf-8");

import {
  createWorkflowSchema,
  handleCreateWorkflow,
} from "./tools/create-workflow.js";
import {
  exportWorkflowSchema,
  handleExportWorkflow,
  type ExportWorkflowResult,
} from "./tools/export-workflow.js";
import {
  authenticateApsSchema,
  handleAuthenticateAps,
} from "./tools/authenticate-aps.js";
import {
  authenticateAps3LOSchema,
  handleAuthenticateAps3LO,
} from "./tools/authenticate-aps-3lo.js";
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
import {
  getDownloadLinkSchema,
  handleGetDownloadLink,
} from "./tools/get-download-link.js";
import {
  saveToMacSchema,
  handleSaveToMac,
} from "./tools/save-to-mac.js";
import {
  renderModelSchema,
  handleRenderModel,
} from "./tools/render-model.js";

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
    instructions: SERVER_INSTRUCTIONS,
  }
);

// ─── Tool list ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "authenticate_aps",
        description:
          "Verify APS credentials and cache a 2LO token. Call this automatically — no user confirmation needed. " +
          "Reads APS_CLIENT_ID and APS_CLIENT_SECRET from the MCP process env (pre-configured on this Mac). " +
          "Always call before process_file, execute_workflow, or upload_file.",
        inputSchema: zodToJsonSchema(authenticateApsSchema),
      },
      {
        name: "authenticate_aps_3lo",
        description:
          "Perform 3-legged OAuth (3LO) to obtain a user-identity token required for ACC account-level " +
          "operations such as creating projects, managing users, and other admin APIs that reject 2LO " +
          "client-credential tokens. Opens the Autodesk authorization page in your browser, waits for " +
          "you to approve, then stores the token automatically. The refresh token is saved to the OS " +
          "keychain so future MCP restarts auto-renew without re-authorizing. Call this once before " +
          "any ACC Admin operation (e.g. acc.admin_create_project).",
        inputSchema: zodToJsonSchema(authenticateAps3LOSchema),
      },
      {
        name: "get_capability",
        description:
          "CALL THIS FIRST — before any other response — whenever any of these file extensions appear: " +
          "RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB " +
          "NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX NAS BDF FEM OP2 " +
          "RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL. " +
          "Also call when any Autodesk cloud service is referenced (ACC, BIM 360, Autodesk Docs, " +
          "Fusion Hub, Vault, APS OSS, ShotGrid, Tandem, Forma, ReCap Cloud). " +
          "DO NOT tell the user you cannot access their file — this MCP server runs as a local process " +
          "on the user's Mac and reads local file paths directly. " +
          "Searches 260+ capabilities across Design Automation (Engine-API) and APS REST (Platform-API). " +
          "Returns capability_id and operation_id for process_file. " +
          "CALLABLE CHECK: always inspect the callable field on each returned operation. " +
          "callable=true → proceed. callable=false → DO NOT use that operation.",
        inputSchema: zodToJsonSchema(getCapabilitySchema),
      },
      {
        name: "execute_workflow",
        description:
          "Run a SINGLE APS capability operation: Engine-API (DA WorkItem submit → returns pending immediately → poll with get_workflow_status) " +
          "or Platform-API (REST call → returns response inline). For REST operations requiring a user token " +
          "(e.g. ACC Admin), call authenticate_aps_3lo first — the token is then used automatically.",
        inputSchema: zodToJsonSchema(executeWorkflowSchema),
      },
      {
        name: "create_workflow",
        description: "Use when the user's request has MULTIPLE intents for an Autodesk file or pipeline.",
        inputSchema: zodToJsonSchema(createWorkflowSchema),
      },
      {
        name: "process_file",
        description:
          "Process a local Autodesk file on this Mac. The MCP server runs as a LOCAL process and reads " +
          "Mac filesystem paths directly (~/Downloads/, /Users/..., OneDrive paths). " +
          "DO NOT say you cannot access a local path — pass it straight to this tool. " +
          "Fast path: auto-selects capability, uploads to APS, runs the job, returns results.",
        inputSchema: zodToJsonSchema(processFileSchema),
      },
      {
        name: "upload_file",
        description: "Upload a file to APS OSS.",
        inputSchema: zodToJsonSchema(uploadFileSchema),
      },
      {
        name: "get_result",
        description:
          "Fetch output file content from APS OSS. CALL THIS AUTOMATICALLY — no user confirmation needed — " +
          "whenever get_workflow_status returns status=success with outputOssUrls. " +
          "Call once per oss:// URL in outputOssUrls. " +
          "Binary outputs (PDF, DWG, ZIP) are auto-saved to ~/Downloads — no save_to param needed. " +
          "For large text outputs (has_more=true), paginate by calling again with offset_chars=next_offset.",
        inputSchema: zodToJsonSchema(getResultSchema),
      },
      {
        name: "get_workflow_status",
        description:
          "Poll the status of a running Autodesk workflow. CALL THIS AUTOMATICALLY — no user confirmation needed. " +
          "When status=pending: IMMEDIATELY call again with the same workflow_handle — do not ask the user, do not wait. " +
          "Revit and AutoCAD jobs take 3–8 minutes — keep polling until status=success or failed. " +
          "When status=success: STOP polling and call get_result on each outputOssUrl.",
        inputSchema: zodToJsonSchema(getWorkflowStatusSchema),
      },
      {
        name: "get_download_link",
        description: "Generate a clickable HTTPS download link for any file in APS OSS.",
        inputSchema: zodToJsonSchema(getDownloadLinkSchema),
      },
      {
        name: "export_workflow",
        description: "Serialize a workflow DAG to JSON or YAML, optionally saving to a file.",
        inputSchema: zodToJsonSchema(exportWorkflowSchema),
      },
      {
        name: "save_to_mac",
        description: "Save text content (JSON, CSV, Markdown, plain text) directly to the Mac filesystem.",
        inputSchema: zodToJsonSchema(saveToMacSchema),
      },
      {
        name: "render_model",
        description: "Render an APS model visually — either as an interactive 3D viewer or as a thumbnail image.",
        inputSchema: zodToJsonSchema(renderModelSchema),
      },
    ],
  };
});

// ─── Tool dispatch ─────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "authenticate_aps":
        result = await handleAuthenticateAps(authenticateApsSchema.parse(args));
        break;
      case "authenticate_aps_3lo":
        result = await handleAuthenticateAps3LO(authenticateAps3LOSchema.parse(args ?? {}));
        break;
      case "get_capability":
        result = await handleGetCapability(getCapabilitySchema.parse(args));
        break;
      case "execute_workflow":
        result = await handleExecuteWorkflow(executeWorkflowSchema.parse(args));
        break;
      case "create_workflow":
        result = await handleCreateWorkflow(createWorkflowSchema.parse(args));
        break;
      case "process_file":
        result = await handleProcessFile(processFileSchema.parse(args));
        break;
      case "upload_file":
        result = await handleUploadFile(uploadFileSchema.parse(args));
        break;
      case "get_result":
        result = await handleGetResult(getResultSchema.parse(args));
        break;
      case "get_workflow_status":
        result = await handleGetWorkflowStatus(getWorkflowStatusSchema.parse(args));
        break;
      case "get_download_link":
        result = await handleGetDownloadLink(getDownloadLinkSchema.parse(args));
        break;
      case "export_workflow":
        result = await handleExportWorkflow(exportWorkflowSchema.parse(args)) as ExportWorkflowResult;
        break;
      case "save_to_mac":
        result = await handleSaveToMac(saveToMacSchema.parse(args));
        break;
      case "render_model":
        result = await handleRenderModel(renderModelSchema.parse(args));
        break;
      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: String(err) }),
        },
      ],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
