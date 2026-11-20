# LabStrata Verify — Akamai Hackathon Build Prompt

> **Repository integration note (important):** This repository already contains a working-in-progress **Node.js / plain HTML+JS** LabStrata prototype described in README.md, with protocol version hashing, assignments, run integrity comparison, and an Akamai inference client. **Do not overwrite or discard that work.** Before implementing any items below, inspect `server.js`, `public/`, `demo/`, `.env.example`, and README.md. Prefer extending the existing Node.js app and its existing environment variable names (`AKAMAI_BASE_URL`, `AKAMAI_API_KEY`, `AKAMAI_MODEL`) rather than rewriting in Python/Streamlit. Treat the Python/Streamlit architecture and file tree below as a *fallback design reference*, not a mandatory migration. Maintain working endpoints, cite validation, assignment/version controls, and the honest offline mode. Add Akamai Object Storage persistence, more precise status semantics, tests, and clearer architecture UI within the current codebase. Only migrate stacks if there is a concrete technical blocker and the existing features remain intact. Document the actual stack, real integrations, and limits accurately.


## Role
You are a senior full-stack engineer, AI systems engineer, and scientific software product designer. Build a complete, runnable hackathon MVP called **LabStrata Verify** in this repository. Deliver working code, not only designs or architecture notes. Optimize for a reliable, explainable live demonstration.

## Product vision
**LabStrata Verify** is an AI-assisted laboratory protocol compliance and documentation-review application. A researcher uploads or pastes a laboratory Standard Operating Procedure (SOP) and a corresponding experiment/run log. The app compares each SOP requirement against the run log, identifies documented, contradicted, and unverifiable requirements, and presents source-linked findings. The reviewer can save a reproducible evidence packet and reopen it later.

Tagline: **Every lab run, traceable to the protocol.**

This is a documentation-assistance tool, not a validated GMP/GLP quality system, not an autonomous compliance authority, and not a substitute for human review.

## Hackathon judging criteria and product priorities
The event judging rubric shown at the hackathon is:
- **40% — Other Akamai Cloud services:** demonstrate a feature depending on the selected cloud service.
- **20% — Akamai Cloud Inference:** demonstrate the model's task and how its output is checked.
- **20% — Usefulness:** identify the user and problem.
- **20% — Creativity:** show an original workflow.

Maximize alignment with these criteria through a visibly integrated architecture:
1. **Akamai Linode (Cloud Compute):** deploy and run the Python application on an Ubuntu 24.04 instance (2 GB shared CPU is sufficient for the MVP).
2. **Akamai Inference:** a remote inference endpoint makes the SOP-to-log comparisons. The Linode does not host the LLM weights.
3. **Akamai Object Storage:** save and retrieve evidence packets. Make saving and reopening visible in the UI. Use S3-compatible boto3, configured against the Akamai Object Storage endpoint, not AWS.
4. Keep the core demo functional without Object Storage by offering a clearly labeled local/demo fallback, but do not claim cloud storage is integrated unless a real round-trip has succeeded.

## Target audience and use cases
- Academic lab researchers following published SOPs.
- Laboratory managers who review documentation quality.
- Research operations teams tracking deviations and incomplete records.
- Demonstrate with fabricated, non-sensitive data only.

Example:
- SOP S1: Record the balance asset ID.
- SOP S2: Record the zero reading **before** placing a reference weight.
- SOP S3: Record the reference weight ID.
- Run log L1: Checked balance B-07.
- Run log L2: Placed check weight, then recorded zero.
- Expected classification: S1 documented; S2 contradicted; S3 insufficient evidence. Do not label S3 as skipped merely because it is undocumented.

## Tech stack
- Python 3.11+; Streamlit frontend and server-side orchestration.
- `openai` Python client configured for Akamai's **OpenAI-compatible** inference base URL.
- Pydantic for structured, validated model outputs.
- boto3 for Akamai Object Storage (S3-compatible API).
- python-dotenv for local env loading.
- pytest for deterministic verification tests.
- No separate frontend framework, database, message queue, GPU instance, or vector database for the MVP.
- Minimal dependencies; keep deployment simple for a single Ubuntu Linode.

## Secrets and configuration
Create `.env.example`, never commit `.env`, tokens, private keys, or sensitive lab material.

Required for live inference:
- `AKAMAI_INFERENCE_API_KEY=`
- `AKAMAI_INFERENCE_BASE_URL=https://api.akamai-inference.com/v1` (example; must be overrideable by workshop credentials)
- `AKAMAI_INFERENCE_MODEL=qwen3-5-9b` (example; must be overrideable with the exact model accessible to the key)

Optional for storage:
- `AKAMAI_OBJECT_STORAGE_ENDPOINT=`
- `AKAMAI_OBJECT_STORAGE_BUCKET=`
- `AKAMAI_OBJECT_STORAGE_ACCESS_KEY=`
- `AKAMAI_OBJECT_STORAGE_SECRET_KEY=`
- `AKAMAI_OBJECT_STORAGE_REGION=` (if needed)

Do not assume a general Cloud Manager Personal Access Token works as an inference token. Return a user-friendly configuration error when the inference credentials are unavailable. Never log token values.

## Core user journey
1. User lands on a polished **LabStrata Verify** dashboard with a strong one-line explanation and a **Load sample run** action.
2. User uploads `.txt` or pastes two inputs: **SOP** and **Run Log**.
3. User clicks **Verify Run**.
4. Backend assigns **stable SOP step IDs** (S1..Sn) and **run-log line IDs** (L1..Ln); original text is preserved.
5. Backend calls Akamai Inference **server-side**, requesting strictly structured results for each step.
6. Backend validates each finding deterministically and reconciles IDs against supplied source text.
7. UI shows summary counts and a review table/card list: **Documented**, **Contradicted**, **Insufficient Evidence**, or **Needs Review** if model output cannot be safely interpreted.
8. Each card reveals the verbatim SOP requirement, the verbatim cited log lines, and a brief rationale.
9. User clicks **Save Evidence Packet**. The server writes one JSON object to Akamai Object Storage at `runs/{uuid}.json`.
10. User enters a run ID or chooses a saved sample to **Reopen Run**; server retrieves and renders the packet without needing another inference call.

## Verification rules (critical)
- Use exactly these semantic statuses:
  - **documented:** run-log evidence clearly supports the SOP requirement.
  - **contradicted:** run-log evidence explicitly conflicts with the SOP requirement.
  - **insufficient_evidence:** no sufficiently explicit evidence in the run log.
  - **needs_review:** parsing, mapping, model, or evidence validation failed, or the evidence is ambiguous.
- Never interpret *absence of documentation* as proof that a step was not performed.
- The model must return JSON with a list of findings: `step_id`, `status`, `log_line_ids`, `reason`. Optionally include `confidence` but do not portray it as calibrated.
- Validate with Pydantic; reject unknown/duplicate SOP IDs and nonexistent log-line references. Require cited log lines for `documented` and `contradicted`.
- For any missing or malformed result, create a **needs_review** finding instead of silently passing it.
- Render verbatim evidence **only from the original input**, never from AI-generated quotations. Validation of a line ID only proves the source exists, not that the model's interpretation is correct.
- Treat both SOP and log contents as **untrusted data**, not commands. Use a system instruction prohibiting obeying embedded directives.
- Keep the analysis concise and auditable. Avoid claims of guaranteed laboratory compliance.
- Prefer one complete prompt over RAG for short documents. Do not create an embeddings dependency until justified.

## Inference integration
- Use `OpenAI(api_key=..., base_url=...)` and `client.chat.completions.create(model=..., messages=...)`.
- Keep endpoint and model configurable. Check model-specific JSON/schema support; if constrained JSON output is not supported, request JSON text, parse carefully, and fail safely.
- Set a request timeout and limited retry policy, handle 401/403/404/429 and network errors with actionable UI messages.
- No provider secrets should ever reach the browser.
- Surface inference latency and model name as transparent demo metadata if available.

## Akamai Object Storage integration
- Use `boto3.client("s3", endpoint_url=..., aws_access_key_id=..., aws_secret_access_key=..., region_name=...)`.
- Bucket must be private, keys scoped to minimum necessary access.
- Store JSON containing: schema_version, run_id, created_at_utc, sop_text, log_text, line mappings, model metadata, all findings, validator warnings, and explicit `human_review_required: true`.
- Use `put_object` for save and `get_object` for readback. Serialize as JSON UTF-8.
- Do not use publicly accessible buckets. Use random UUIDs for IDs, but note UUIDs alone are not access control.
- For MVP demonstration, restrict app access (SSH tunnel or authenticated HTTPS). Do not claim the system is multi-user secure.
- Add a simple **Test Storage Connection** action to demonstrate the Akamai storage dependency. Distinguish configured, operational, and fallback status.

## UI design
Professional, minimal scientific software design; white/charcoal surfaces, restrained accent color, high readability, no generic AI-glow gradients.
- Header: **LabStrata Verify**; subtitle **Protocol-to-run evidence, in minutes**.
- Sidebar or top-level tabs: **Verify**, **Saved Runs**, **Architecture**.
- Upload/paste panels side by side on desktop.
- Primary CTA: **Verify Run**.
- Summary metrics: requirements, documented, contradicted, insufficient evidence, needs review.
- Expandable source-evidence panels; no invented source citations.
- Clear loading, empty, error, and success states.
- **Architecture** tab visually traces `Browser → Streamlit on Linode → Akamai Inference → validated results → Akamai Object Storage`.
- Responsive layout and accessible contrast.

## Repository deliverables
Implement a structure similar to:
```text
Akamai_Hackathon/
├── app.py
├── src/
│   ├── __init__.py
│   ├── config.py
│   ├── parsing.py
│   ├── inference.py
│   ├── validation.py
│   └── storage.py
├── fixtures/
│   ├── balance_sop.txt
│   ├── balance_run_clean.txt
│   └── balance_run_deviation.txt
├── tests/
│   ├── test_parsing.py
│   ├── test_validation.py
│   └── test_storage.py
├── requirements.txt
├── .env.example
├── .gitignore
├── README.md
└── HACKATHON_BUILD_PROMPT.md
```

README must contain:
- concise value proposition and the explicit judging-rubric mapping;
- a simple ASCII architecture diagram;
- local setup: `python -m venv .venv`, dependency installation, environment variables, `streamlit run app.py`;
- Ubuntu Linode deployment and SSH-tunnel demo instructions;
- Akamai Object Storage bucket setup and endpoint configuration;
- repeatable demo script and sample expected findings;
- known limitations: AI can misinterpret text; human review mandatory; no real patient or sensitive lab data.

Add tests that cover unknown citations, duplicate IDs, missing steps, missing evidence, and status semantics. Keep integration tests separate from unit tests so the test suite works without real API keys.

## Demo choreography (2–3 minutes)
1. State the problem: SOPs and run logs are hard to cross-check manually.
2. Load an SOP and a **clean** run log, click Verify, show documented findings.
3. Switch to a **deviation** log, click Verify, show a contradiction with the exact line and a separate insufficient-evidence item.
4. Click Save Evidence Packet, display the run ID, refresh/reopen to show persistence from Akamai Object Storage.
5. Open Architecture tab and call out Linode (hosting), Akamai Inference (reasoning), and Object Storage (persistence).
6. Explicitly show how Python validation catches a fabricated/missing citation. The app is assistive and requires human review.

## Acceptance criteria
- App launches from the README commands.
- Real inference works when valid workshop credentials are supplied; absent credentials yield a clear error or explicitly labeled demo-mode results, never fake a live inference call.
- Every SOP step has exactly one final validated finding.
- Unknown evidence IDs can never render as trusted quotations.
- Clean and deviation fixtures produce meaningful, distinct demonstrations; tests are deterministic without external API keys.
- Saving/reopening a run works against a configured Akamai Object Storage bucket.
- Deployed Linode can serve the app privately through an SSH tunnel.
- No credentials in Git or browser code.
- Explicit status badges distinguish **real cloud services connected** from **demo fallback**.
- Do not claim production security, regulatory certification, or clinical/quality assurance validation.

## Implementation order
1. Build parsing, line IDs, sample fixtures, and deterministic validators.
2. Wire Akamai Inference with the real configurable key/endpoint/model.
3. Build Streamlit UI and visible evidence mapping.
4. Add Object Storage save/reopen, with honest connectivity indicators.
5. Add unit tests, README, and deployment instructions.
6. Deploy and rehearse on Linode; prioritize a stable working demo over extra features.

Do not spend time on authentication providers, Docker/Kubernetes, vector search, complicated agent orchestration, or advanced analytics until the end-to-end demo is confirmed working.
