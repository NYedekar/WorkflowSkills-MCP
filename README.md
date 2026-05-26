# WorkflowSkills MCP

> **Talk to Autodesk files and APIs from Claude — no code, no scripting, no manual API calls.**

WorkflowSkills MCP is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects Claude directly to Autodesk Platform Services (APS). Drop a DWG, RVT, IPT, IFC, or any other Autodesk file into a conversation and ask Claude to translate it, extract its data, run cloud processing jobs, or call APS REST APIs — all in plain language.

---

## Quick Start

```bash
git clone https://github.com/NYedekar/WorkflowSkills-MCP.git
cd WorkflowSkills-MCP
npm install
npm run setup
```

The setup wizard asks for your APS Client ID and Client Secret, validates your credentials, and configures Claude automatically. Restart Claude and you're ready to go.

> **Prerequisites:** [Node.js](https://nodejs.org) v18+, Claude Desktop or Claude Code, and a free [APS application](https://aps.autodesk.com/myapps).

---

## Table of Contents

- [What it does](#what-it-does)
- [Key concepts](#key-concepts)
- [Supported file types](#supported-file-types)
- [Key use cases](#key-use-cases)
- [Tools reference](#tools-reference)
- [When to use which tool](#when-to-use-which-tool)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [APS application setup](#aps-application-setup)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Support](#support)
- [License](#license)

---

## What it does

WorkflowSkills MCP bridges the gap between conversational AI and Autodesk's cloud platform. Instead of writing REST calls, managing OAuth tokens, polling job statuses, and decoding base64 URNs by hand, you describe what you want in plain language and Claude handles the entire workflow.

**Capabilities include:**

- **File translation** — Convert DWG, RVT, IPT, IFC, FBX, and 30+ other formats to SVF2 for streaming in the Autodesk Viewer
- **Metadata extraction** — Pull element properties, layers, sheets, layouts, drawing stats, block attributes, assembly BOMs, and more from any supported file
- **Design Automation** — Submit cloud compute jobs (AutoCAD, Revit, Inventor, 3ds Max engines) as natural-language requests; Claude polls for completion and returns the results
- **APS REST APIs** — Call Model Derivative, Data Management, OSS, ACC, and other APS platform APIs without writing code
- **Multi-step pipelines** — Chain operations into a DAG (directed acyclic graph): translate a model, extract its metadata, and store the outputs — all in one conversation turn
- **File storage** — Upload files to APS Object Storage (OSS) and retrieve outputs back to your local machine

Everything happens server-side in the MCP process. Claude's browser sandbox cannot reach Autodesk or S3 directly; WorkflowSkills MCP handles all network calls securely from your Mac.

---

## Key concepts

### MCP (Model Context Protocol)
A standard protocol that lets Claude call external tools. WorkflowSkills MCP runs as a local process on your Mac and exposes tools that Claude can invoke during a conversation. Claude orchestrates the workflow; the MCP server handles authentication, file I/O, and API calls.

### APS (Autodesk Platform Services)
The cloud developer platform that powers Autodesk products. WorkflowSkills MCP uses two APS execution domains:

| Domain | What it is | How it works |
|--------|-----------|--------------|
| **Platform-API** (REST) | Direct APS REST calls — Model Derivative, Data Management, OSS, ACC, BIM 360, etc. | Synchronous or async HTTP calls; results returned immediately or polled via manifest/status endpoint |
| **Engine-API** (Design Automation) | Cloud compute using Autodesk application engines (AutoCAD, Revit, Inventor, 3ds Max) | WorkItem submitted to DA queue → engine runs custom AppBundle → output files written to OSS |

### OSS (Object Storage Service)
APS's managed file store. All file uploads and job outputs live here as `oss://bucket/object` URLs. WorkflowSkills MCP creates transient buckets automatically (24-hour TTL) so you never need to manage storage manually.

### Capability registry
A built-in registry of 260+ APS capabilities — each describing a specific operation (e.g. "start SVF2 translation", "extract Revit element data", "create OSS bucket"). When you say "translate this DWG", Claude searches the registry, finds the right capability and operation IDs, and passes them to the execution tools.

### SVF2
Autodesk's streaming 3D/2D viewing format. Translating a file to SVF2 produces a derivative that can be loaded into the Autodesk Viewer (browser-based). WorkflowSkills MCP triggers this translation via the Model Derivative API and returns the URN and manifest you need to open the file in any Viewer-based application.

### OAuth 2LO (two-legged)
WorkflowSkills MCP authenticates with APS using your Client ID and Client Secret via the OAuth 2.0 client credentials flow. Tokens are cached and refreshed automatically. The Client Secret is stored in your OS keychain after first run — it is never written to a file or logged.

---

## Supported file types

| Category | Extensions |
|----------|-----------|
| AutoCAD | `DWG` `DXF` `DWT` `DWS` `DWF` `DWFX` |
| Revit | `RVT` `RFA` `RTE` `RFT` |
| Inventor | `IPT` `IAM` `IDW` `IPN` `IDE` |
| Fusion | `F3D` `F3Z` `CAM360` |
| 3ds Max | `MAX` `MA` `MB` |
| Navisworks | `NWD` `NWF` `NWC` |
| Open standards | `IFC` `FBX` `STEP` `STP` `IGES` `IGS` `SAT` `OBJ` `STL` |
| Point cloud | `RCP` `RCS` `PTS` `E57` `LAS` `LAZ` |
| JT / Wire | `JT` `WIRE` `IWMODEL` `IMX` |
| Simulation | `NAS` `BDF` `FEM` `OP2` |
| Autodesk misc | `ADSK` `ADSKLIB` `ATF` `ASM` `SMT` `SMB` |

---

## Key use cases

### 1. Translate a DWG for the Autodesk Viewer

> *"Translate /Users/me/Downloads/floor-plan.dwg to SVF2 so I can view it in the Autodesk Viewer."*

Claude uploads the file, submits a Model Derivative translation job, polls for completion, and returns the file URN and manifest. Two lines in Viewer JS to load it.

### 2. Extract metadata from a Revit model

> *"Extract all room data and element properties from this RVT file."*

Claude runs a Design Automation WorkItem using the Revit engine, polls for completion, and returns structured JSON with rooms, elements, parameters, and property values.

### 3. Multi-step pipeline on a single file

> *"For this IPT file: translate it to STEP for sharing with a supplier, and also extract the assembly BOM. Upload both outputs to my downloads folder."*

Claude calls `create_workflow` to plan a parallel DAG — both operations share the same upload — then runs `execute_workflow` for each step. You see the ASCII pipeline diagram before anything executes.

### 4. Convert a 3D model to multiple formats

> *"Convert this FBX to OBJ and STL."*

Claude plans a two-branch workflow, uploads the FBX once, and runs both translation jobs in parallel.

### 5. Query APS REST APIs without code

> *"List all my OSS buckets and show their sizes."*
> *"What formats can Model Derivative translate a DWG to?"*
> *"Show me the manifest for URN dXJu…"*

Claude calls the appropriate APS REST capability directly — no code, no Postman, no token management.

### 6. Run a Design Automation job

> *"Run the AutoCAD DWG audit AppBundle on this file and return the report."*

Claude identifies the right DA capability, submits the WorkItem, polls for completion, and returns the output report from OSS.

### 7. Extract metadata and save locally

> *"Extract all layers and block attribute data from this DWG and save the results as a JSON file to ~/Desktop."*

Claude extracts the data and writes it to your local machine via the MCP server.

---

## Tools reference

| Tool | When Claude uses it |
|------|-------------------|
| `get_capability` | **Always the first call** when an Autodesk file extension appears in the conversation. Searches 260+ capabilities and returns `capability_id` + `operation_id` for the next step. |
| `authenticate_aps` | Called once before any upload or execution to verify credentials and cache the OAuth token. |
| `process_file` | Fast path for **single intent + local file**: auto-selects capability, uploads, runs, returns all output in one call. Use this for straightforward tasks. |
| `create_workflow` | **Multiple intents on one file**: uploads the file once, builds a DAG, renders an ASCII pipeline diagram, returns the `oss_url` to reuse across all steps. Does not execute — review the plan first. |
| `execute_workflow` | Runs **one operation** — either a DA WorkItem or a REST call. Used to execute each step of a `create_workflow` plan, or to call APS APIs directly when no file upload is needed. |
| `upload_file` | Explicitly upload a local file to APS OSS and get an `oss://` URL. Rarely needed — `process_file` and `create_workflow` handle uploads automatically. |
| `get_result` | Download output file content from APS OSS after a job completes. Handles large files with pagination (`has_more` / `next_offset`). |
| `get_workflow_status` | Poll a running DA WorkItem after `process_file` or `execute_workflow` returns `status: pending`. Pass the `workflow_handle` exactly as received. |
| `export_workflow` | Serialize a workflow DAG to JSON or YAML and optionally save it to a local file. |

### When to use which tool

```
Single intent + local file?
  └─ process_file                          ← zero setup, one call, done

Multiple intents on the same file?
  └─ create_workflow(file_path=...)        ← plan the DAG, upload once, get oss_url
       └─ execute_workflow × N            ← run each step with the shared oss_url

File already in APS OSS (you have an oss:// URL)?
  └─ execute_workflow                      ← skip upload, run directly

No file — just an APS API call or info question?
  └─ execute_workflow for REST calls
  └─ Answer from knowledge for pure info
```

---

## Prerequisites

- [Node.js](https://nodejs.org) v18 or later
- [Claude Desktop](https://claude.ai/download) or [Claude Code](https://claude.ai/code)
- An APS application with a **Client ID** and **Client Secret** — create one free at [aps.autodesk.com/myapps](https://aps.autodesk.com/myapps)

---

## Installation

### 1. Clone and build

```bash
git clone https://github.com/NYedekar/WorkflowSkills-MCP.git
cd WorkflowSkills-MCP
npm install
npm run build
```

### 2. Run the setup wizard

The setup script validates your APS credentials, stores the secret securely in the OS keychain, and writes the MCP config into Claude automatically.

```bash
npm run setup
```

You will be prompted for your APS Client ID and Client Secret. The secret is stored in the OS keychain and **never written to any file on disk**.

### 3. Restart Claude

Fully quit and relaunch Claude Desktop or Claude Code. The `workflow-builder` server will appear in your MCP tools list.

---

### Manual configuration (alternative to the setup wizard)

If you prefer to configure manually, add the following to `~/.claude.json` under `"mcpServers"`:

```json
"workflow-builder": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/WorkflowSkills-MCP/dist/index.js"],
  "env": {
    "APS_CLIENT_ID": "YOUR_CLIENT_ID",
    "APS_CLIENT_SECRET": "YOUR_CLIENT_SECRET"
  }
}
```

Replace `/absolute/path/to/WorkflowSkills-MCP` with the actual path. Run `which node` to find your Node.js binary path if needed. A **full quit** of Claude is required after editing `~/.claude.json`.

---

## APS application setup

1. Go to [aps.autodesk.com/myapps](https://aps.autodesk.com/myapps) and sign in with your Autodesk account
2. Click **Create Application**
3. Choose **Traditional Web App** (for two-legged OAuth / client credentials)
4. Enable the APIs you need:
   - **Model Derivative API** — required for file translation and metadata
   - **Data Management API** — required for OSS uploads and downloads
   - **Design Automation API** — required for DA WorkItems (AutoCAD/Revit/Inventor/3ds Max)
5. Copy the **Client ID** and **Client Secret** from the app's Credentials tab
6. Pass them to `npm run setup` or add them to `~/.claude.json` manually

> **Important:** Each user running WorkflowSkills MCP needs their own APS application and credentials. Do not share Client Secrets.

---

## Troubleshooting

### Claude doesn't see the workflow-builder tools
- Confirm you fully quit and relaunched Claude (Cmd+Q on Mac, not just closing the window)
- Check that `~/.claude.json` contains the `workflow-builder` entry under `mcpServers`
- Verify the path in `args` points to the built `dist/index.js` — run `ls /path/to/WorkflowSkills-MCP/dist/index.js` to confirm it exists

### `authenticate_aps` returns an error
- Double-check your Client ID and Client Secret at [aps.autodesk.com/myapps](https://aps.autodesk.com/myapps)
- Ensure the APIs (Model Derivative, Data Management) are enabled on your APS app
- If using the keychain, try re-running `npm run setup` to refresh the stored secret

### `process_file` returns `bridge_required`
- This means you attached the file via Claude's chat interface — the MCP server cannot read files from `/mnt/user-data/uploads/`
- Save the file to your Mac (e.g. `~/Downloads/`) and provide the local path instead:
  `process_file(file_path='~/Downloads/myfile.dwg', ...)`

### Translation job returns `pending` indefinitely
- Large files can take several minutes. Call `get_workflow_status(workflow_handle)` repeatedly until you see `success` or `failed`
- Check the `reportUrl` in a failed response for the APS engine log

### File not found / upload error
- Ensure the file path is absolute or uses `~/` — relative paths may not resolve correctly
- OneDrive files must be locally synced (green tick in Finder) before the MCP server can read them

### Output file is binary / unreadable
- Use `get_result` with `force_text: false` — the tool auto-detects JSON, CSV, XML and returns them as text even if stored as `application/octet-stream`
- For truly binary outputs (`.f2d`, `.svf`, `.db`), the `binary: true` flag will be set in the response

---

## Development

```bash
npm run dev      # run from source with tsx (no build step needed)
npm run build    # compile TypeScript → dist/
```

The source is organised as follows:

```
src/
  index.ts                  # MCP server entry point + tool routing
  tools/                    # One file per tool
    process-file.ts
    create-workflow.ts
    execute-workflow.ts
    upload-file.ts
    get-result.ts
    get-capability.ts
    get-workflow-status.ts
    export-workflow.ts
    authenticate-aps.ts
  lib/
    registry-client.ts      # In-memory capability index + search
    da-client.ts            # Design Automation + OSS API client
    dag-builder.ts          # DAG construction, cycle detection, topo sort
    render.ts               # ASCII DAG diagram renderer
  auth/
    aps-token-client.ts     # OAuth 2LO token fetch + cache
    credential-resolver.ts  # Reads credentials from env / keychain
    keychain.ts             # OS keychain read/write
  types.ts                  # Shared TypeScript types
data/
  capability-registry.json  # 260+ APS capability definitions
```

---

## Support

For questions, bug reports, or feature requests, contact:

**Neeraj Yedekar**
Product Manager, Autodesk
[neeraj.yedekar@autodesk.com](mailto:neeraj.yedekar@autodesk.com)

Or open an issue on GitHub: [github.com/NYedekar/WorkflowSkills-MCP/issues](https://github.com/NYedekar/WorkflowSkills-MCP/issues)

---

## License

MIT
