=== WorkflowSkills MCP ===

CRITICAL FACTS — read before doing anything:
1. This MCP server runs as a LOCAL PROCESS on the user's Mac. It reads Mac filesystem paths directly.
2. NEVER say "I cannot access your local file" — pass the path to process_file immediately.
3. NEVER ask for permission before calling authenticate_aps — just call it. Credentials are pre-configured.
4. Local paths that work: ~/Downloads/, /Users/yedekan/..., ~/Library/CloudStorage/OneDrive-Autodesk/...

MANDATORY TRIGGER — call get_capability as your VERY FIRST action (before any response, any reasoning, any bash, any Python) when ANY of these file extensions appear anywhere in the conversation — attached, typed as a path, or mentioned by name:

RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL

These are Autodesk proprietary formats. DO NOT attempt to read, parse, or process them using Python, bash, olefile, rvt-meta, or any local library — they require APS cloud services and will fail or produce wrong results locally.

── TOOL SELECTION ───────────────────────────────────────────────────────

Use this decision tree every time before picking a tool:

1. Single intent + local file?
   → process_file  (fast path: upload + run + return results in one call. No planning needed.)

2. Multiple intents + local file?
   → create_workflow(file_path=..., intents=[...])  — uploads the file ONCE, builds the DAG, returns oss_url.
   → Then execute_workflow(input_file_url=oss_url, ...) for each step in the DAG.
   NEVER call process_file multiple times for the same file — it re-uploads each time.

3. File already in APS OSS (you have an oss:// URL)?
   → execute_workflow directly — no upload needed.

4. No file, just an APS REST operation or info question?
   → execute_workflow for REST calls. Answer from knowledge for pure info.

── STANDARD FLOW ────────────────────────────────────────────────────────

Step 1 — get_capability(query='<ext> <intent>') — call immediately, no confirmation needed.
Step 2 — authenticate_aps() — call immediately, no confirmation needed. Credentials are pre-configured.
         • error → stop. Show error. Ask user to check APS credentials.
Step 3 — Execute using the tool selected above (process_file or create_workflow + execute_workflow).

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
  Step 3 · execute_workflow(capability_id='aps:md.manifest', operation_id='fetch_manifest', path_params={urn})
           → confirms translation complete. DO NOT use GUIDs from this manifest for metadata calls.
  Step 4 · execute_workflow(capability_id='aps:md.metadata', operation_id='list_model_views', path_params={urn})
           → returns correct modelGuids. ALWAYS use these GUIDs — manifest geometry GUIDs are different and will 404.
  Step 5a · execute_workflow(capability_id='aps:md.metadata', operation_id='fetch_object_tree', path_params={urn, modelGuid})
            → entity/layer/component hierarchy.
  Step 5b · execute_workflow(capability_id='aps:md.metadata', operation_id='query_specific_properties',
            path_params={urn, modelGuid}, body={query:{$prefix:['CategoryName']}})
            → filtered properties by category. PREFER this over fetch_all_properties to avoid 1MB limit.
  Step 5c · execute_workflow(capability_id='aps:md.thumbnail', operation_id='fetch_thumbnail', path_params={urn})
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
• pending         → Engine-API WorkItem submitted. ALWAYS call get_workflow_status(workflow_handle) next.
                    Repeat get_workflow_status until status='success' or 'failed' — each call polls for ~15s.
                    When success: call get_result on each outputOssUrls entry.
• failed          → WorkItem failed. Check reportUrl for the DA execution log.
• bridge_required → show REQUIRED_ACTION verbatim. Ask for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path.
