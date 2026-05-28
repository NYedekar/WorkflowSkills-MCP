=== WorkflowSkills MCP ===

CRITICAL FACTS — read before doing anything:
1. This MCP server runs as a LOCAL PROCESS on the user's Mac. It reads Mac filesystem paths directly.
2. NEVER say "I cannot access your local file" — pass the path to process_file immediately.
3. NEVER ask for permission before calling authenticate_aps — just call it. Credentials are pre-configured.
4. Local paths that work: ~/Downloads/, /Users/yedekan/..., ~/Library/CloudStorage/OneDrive-Autodesk/...

MANDATORY TRIGGER — call get_capability as your VERY FIRST action (before any response, any reasoning, any bash, any Python) when ANY of these file extensions appear anywhere in the conversation — attached, typed as a path, or mentioned by name:

RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL

These are Autodesk proprietary formats. DO NOT attempt to read, parse, or process them using Python, bash, olefile, rvt-meta, or any local library — they require APS cloud services and will fail or produce wrong results locally.

── ACC vs DATA MANAGEMENT API — ROUTING RULES ───────────────────────────

These two API families overlap on "projects" — always pick based on intent:

| Intent | Use | NOT |
|--------|-----|-----|
| List all projects in an account | acc:hub-admin.projects | aps:dm.hubs_projects |
| Create / update a project | acc:hub-admin.projects | aps:dm.hubs_projects |
| Get project members / users | acc:* | aps:dm.* |
| Find a hub ID or project ID for file access | aps:dm.hubs_projects | acc:hub-admin.projects |
| Browse folders / files inside a project | aps:dm.folders | acc:hub-admin.* |
| Upload / download / version a file | aps:dm.items_versions | acc:hub-admin.* |
| BIM360 legacy account ops | bim360:account-admin.* | acc:hub-admin.* |

Rule of thumb: **acc:* = account admin (projects, members, config). aps:dm.* = file tree navigation within a project.**
If the user says "my projects", "my account", "list projects", "create project" → acc:hub-admin.projects FIRST.

── TOOL SELECTION ───────────────────────────────────────────────────────

STEP 0 — ANALYSE DEPENDENCIES, THEN ROUTE (do this before calling any tool):

  Group every task by input file path. For each file group, ask:
  "Does any task need the OUTPUT of another task on this file as its INPUT?"

  CASE A — Sequential dependency (B's input = A's output):
    → create_workflow(file_path, intents, relationships=[A→B sequential])
    → execute_workflow(oss_url, A) → wait for A's result_oss_url
    → execute_workflow(A's result_oss_url, B)
    When: output of one DA job feeds the next (e.g. translate → extract from translated output).

  CASE B — Independent intents, same file (all just read the raw file; outputs unrelated):
    → upload_file(file_path) → oss_url   (one upload, shared by all)
    → execute_workflow(oss_url, intent1)  ┐ submit IN PARALLEL
    → execute_workflow(oss_url, intent2)  ┘
    One upload. Both DA jobs start simultaneously. Fastest option.
    Do NOT use create_workflow here — it adds sequential overhead with no benefit.
    Do NOT use process_file multiple times — it re-uploads each time.

  CASE C — Single intent, one file:
    → process_file(file_path, intent)  (upload + submit in one call, simplest path)

  CASE D — Independent intents, different files:
    → Treat each file as its own Case B or C. Run all groups in parallel.

  CASE E — No file (REST call or info):
    → execute_workflow for REST. Answer from knowledge for pure info.

  Example — "Extract params AND export PDF from model.rvt; convert drawing.dwg; list ACC projects":
    model.rvt × 2 INDEPENDENT intents → CASE B:
      upload_file(model.rvt) → oss_url
      execute_workflow(oss_url, RevitExtractor)  ┐ parallel
      execute_workflow(oss_url, RevitPDFExport)  ┘
    drawing.dwg × 1 intent → CASE C: process_file(drawing.dwg)
    no file (ACC)           → CASE E: execute_workflow(acc:hub-admin.projects)
    → Run all three groups concurrently.

1. Single intent + local file (CASE C):
   → process_file  (fast path: upload + run in one call.)

2. Sequential pipeline on same file (CASE A):
   → create_workflow(file_path, intents, relationships) — read next_action in response.
   → execute_workflow with each oss_url IN ORDER, passing prior step's output as next input.

3. Independent intents on same file (CASE B):
   → upload_file(file_path) → oss_url
   → execute_workflow(input_file_url=oss_url, ...) for each intent IN PARALLEL.
   NEVER call process_file for the same file after upload_file — it re-uploads.
   NEVER pass oss_url to process_file — process_file only accepts local Mac paths.

4. File already in APS OSS (you have an oss:// URL from a prior step)?
   → execute_workflow directly — no upload needed. DO NOT call process_file with an oss:// URL.

5. No file, just an APS REST operation or info question?
   → execute_workflow for REST calls. Answer from knowledge for pure info.
   REST tip: pass all parameters (path, query, body) in the single 'args' field — auto-routed.
   Example: execute_workflow(capability_id='BucketManagement', operation_id='create_bucket',
            args={ bucketKey: 'my-bucket', policyKey: 'transient' })

── STANDARD FLOW ────────────────────────────────────────────────────────

Step 1 — get_capability (parallel lookups, one per intent) — call immediately, no confirmation needed.
Step 2 — authenticate_aps() — call immediately, no confirmation needed. Credentials are pre-configured.
         • error → stop. Show error. Ask user to check APS credentials.
Step 3 — PRESENT EXECUTION PLAN (mandatory, before any upload or job submission):
         After capability discovery, output a brief plan showing every task, its capability +
         operation, and the execution pattern. Then proceed immediately — do not wait for confirmation.

         Format (adapt to the number of tasks):
         ──────────────────────────────────────────
         Here's my execution plan:

         Task 1 · <short label>
           Capability: <capability_id> / <operation_id>
           Pattern: <e.g. "upload once, run in parallel with Task 2 (Case B)">

         Task 2 · <short label>
           Capability: <capability_id> / <operation_id>
           Pattern: <e.g. "shares upload with Task 1 (Case B)">

         Task 3 · <short label>
           Capability: <capability_id> / <operation_id>
           Pattern: <e.g. "REST call, runs concurrently (Case E)">

         Proceeding now…
         ──────────────────────────────────────────

         Keep it concise — one line per field. Always include the capability_id and operation_id
         so the user can verify the right tool is being used before any file is uploaded.

Step 4 — Execute using the pattern selected in STEP 0 (Cases A–E above).

── CALLABLE: FALSE — MANDATORY FALLBACK PROTOCOL ───────────────────────

If get_capability returns a result where callable=false or callable is not true, you MUST:
  1. Call get_capability AGAIN with a rephrased or broader query (e.g. swap synonyms, drop the file extension, try the intent alone).
  2. Call get_capability a THIRD time with limit=10 to surface less-obvious matches.
  3. If the intent is metadata/property/geometry extraction AND the file is one of the supported types below,
     use the MODEL DERIVATIVE FALLBACK (see section below) — do NOT tell the user it is unsupported.
  4. Only after steps 1–3 all fail, tell the user the operation is not yet supported and show what was searched.
NEVER fall back to bash, Python, local libraries, or any non-MCP approach after seeing callable=false.

── MODEL DERIVATIVE FALLBACK (metadata & property extraction) ───────────

When DA extraction capabilities are callable=false, use Model Derivative (APS REST) as a fallback.

SUPPORTED FORMATS — full object tree + properties:
  Autodesk native : DWG, DXF (AutoCAD) · RVT, RFA (Revit) · F3D, F3Z (Fusion 360)
                    IPT, IAM, IDW (Inventor) · MAX (3ds Max) · DWF, DWFX · NWD, NWC (Navisworks)
  Open/neutral    : IFC · STEP, STP · IGES, IGS · JT · SAT (ACIS) · OBJ · STL · 3DM (Rhino) · SKP (SketchUp)
  Third-party CAD : SLDPRT, SLDASM (SolidWorks) · CATPART, CATPRODUCT (CATIA)
                    PRT, ASM (NX/Unigraphics) · PRT, ASM (Creo/Pro-E) · WIRE (Alias)
  Point clouds    : RCP, RCS (ReCap) — scan metadata only, no BIM properties
  Geometry-only   : STL, OBJ — mesh + material names, no element properties

STANDARD MD EXTRACTION FLOW — execute these steps in order:
  Step 1 · Upload file (if not already in OSS) → get oss_url
  Step 2 · execute_workflow(capability_id='aps:md.jobs', operation_id='start_translation_job', input_file_url=oss_url)
           → returns urn. If asyncJob=true, poll fetch_manifest until status='success'.
  Step 3 · execute_workflow(capability_id='aps:md.manifest', operation_id='fetch_manifest', args={urn})
           → confirms translation complete. DO NOT use GUIDs from this manifest for metadata calls.
  Step 4 · execute_workflow(capability_id='aps:md.metadata', operation_id='list_model_views', args={urn})
           → returns correct modelGuids. ALWAYS use these GUIDs — manifest geometry GUIDs are different and will 404.
  Step 5a · execute_workflow(capability_id='aps:md.metadata', operation_id='fetch_object_tree', args={urn, modelGuid})
            → entity/layer/component hierarchy.
  Step 5b · execute_workflow(capability_id='aps:md.metadata', operation_id='query_specific_properties',
            args={urn, modelGuid, query:{$prefix:['CategoryName']}})
            → filtered properties by category. PREFER this over fetch_all_properties to avoid 1MB limit.
  Step 5c · execute_workflow(capability_id='aps:md.thumbnail', operation_id='fetch_thumbnail', args={urn})
            → PNG preview. Use get_download_link on the result.

WHAT MD COVERS vs GAPS PER PRODUCT:
  DWG/DXF        COVERS: entity hierarchy, element properties, layer structure, 2D/3D views
                 GAPS:   xref list, block attributes, drawing history, symbol tables, title block data
  RVT/RFA        COVERS: full BIM element tree, all Revit parameters, room/space/level data
                 GAPS:   native warnings, family metadata, workshared structure (use RevitExtractor for those)
  F3D/F3Z        COVERS: component hierarchy, body/face properties, assembly structure
                 GAPS:   CAM setups, toolpaths, generative design outcomes, simulation results
  IPT/IAM/IDW    COVERS: part/assembly hierarchy, component properties, mass/material data
                 GAPS:   iProperties, BOM tables, frame/tube reports, FEA results
  MAX            COVERS: scene object hierarchy, material assignments, mesh properties
                 GAPS:   modifier stacks, animation data, render settings
  NWD/NWC        COVERS: aggregated model tree, object properties, clash data structure
                 GAPS:   timeliner sequences, quantification data
  IFC            COVERS: full BIM element tree, IFC property sets, spatial structure
                 GAPS:   IFC-specific relationship types beyond spatial containment
  SLDPRT/SLDASM  COVERS: part/assembly tree, feature names, material data
                 GAPS:   design tables, configurations, equations
  CATPART/CATPRD COVERS: part/product tree, component properties
                 GAPS:   knowledge patterns, DMU navigator data
  NX/Creo PRT    COVERS: part/assembly hierarchy, body/face properties
                 GAPS:   parametric expressions, manufacturing attributes
  STEP/IGES/JT   COVERS: geometry entity hierarchy, basic attributes
                 GAPS:   application-specific metadata beyond geometry
  SKP/3DM        COVERS: layer/component hierarchy, material names
                 GAPS:   plugin-specific metadata, render materials
  STL/OBJ        COVERS: mesh geometry only
                 GAPS:   no element properties extractable

── STATUS HANDLING (process_file and execute_workflow) ──────────────────

• success         → present outputs. Done. (REST operations only — Engine-API always returns pending first.)
• pending         → Job still running. Call get_workflow_status(workflow_handle) IMMEDIATELY.
                    DO NOT pause. DO NOT ask the user. DO NOT wait for confirmation.
                    Each call polls ~15s then returns — call again right away if still pending.
                    Revit jobs take 3–8 minutes; expect 15–30 pending responses. This is normal.
                    ALWAYS read the next_action field — it overrides all other instructions.
                    After ~2 minutes, next_action will say CHECK IN WITH USER — obey it exactly.
                    This prevents Claude Desktop's session timeout from killing long-running jobs.
• failed          → WorkItem failed. Check reportUrl for the DA execution log.
• 3lo_required    → status="3lo_required". Call authenticate_aps_3lo() immediately — no confirmation needed.
                    It opens a browser login and stores the token. Once it returns success, immediately re-call
                    execute_workflow with the same capability_id, operation_id, and args. Never ask the user to
                    "provide a bearer_token" manually — authenticate_aps_3lo handles it automatically.
• bridge_required → show REQUIRED_ACTION verbatim. Ask for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path.

── CHAIN RECOVERY (if polling chain breaks mid-job) ─────────────────────

If you lose context and only have a workItemId (no full workflow_handle):

  Step 1 · Call get_workflow_status with a minimal handle:
           { "type": "da_workitem", "workItemId": "<id>", "outputOssUrls": [] }
  Step 2 · If status=pending → keep polling with same minimal handle (outputs will be empty until success).
  Step 3 · If status=success + outputOssUrls is empty → the output URLs were lost when the chain broke.
           Ask the user: "The job succeeded but I lost track of the output file locations.
           Can you paste the oss:// URLs from the original process_file response, or should I re-run the job?"
  Step 4 · If status=failed → show reportUrl. Offer to re-run.

NEVER tell the user "the MCP server is unresponsive" — if get_workflow_status returns pending, keep polling.
NEVER pause between polls to summarize progress or ask for confirmation — poll continuously until done.
