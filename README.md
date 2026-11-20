# LabStrata

Scientists build protocols, assign an exact version, and compare the protocol actually run with the assigned version. **LabStrata Verify** reviews a run log against its SOP using Akamai Inference, validates source citations, and saves reproducible evidence packets to private Akamai Object Storage.

The existing Node.js server, plain HTML/JS interface, SHA-256 protocol versions, assignments, and run integrity workflow are preserved. This is a documentation-assistance prototype; every result requires human review.

## Run locally

Requires Node.js 22 or 24. The only application dependency is the AWS SDK v3 S3 client.

```bash
npm ci --ignore-scripts
cp .env.example .env
npm start
```

On PowerShell use `Copy-Item .env.example .env`. Edit `.env` locally; never paste credentials into chat, screenshots, source files, or shell arguments. Open `http://127.0.0.1:3000`.

| Setting | Purpose |
| --- | --- |
| `AKAMAI_BASE_URL` | Workshop default: `https://api.akamai-inference.com/v1` |
| `AKAMAI_API_KEY` | Privately supplied event key; never returned by the API |
| `CHAT_MODEL` | Workshop default: `qwen3-8-27b` |
| `AKAMAI_MODEL` | Optional legacy override; takes precedence over `CHAT_MODEL` |
| `OBJ_ENDPOINT` | Workshop Chicago E3 endpoint: `https://us-ord-10.linodeobjects.com` |
| `OBJ_REGION` | S3 signing region, default `us-east-1` |
| `OBJ_BUCKET` | Your private bucket name |
| `OBJ_ACCESS_KEY`, `OBJ_SECRET_KEY` | Bucket-scoped read/write credentials |
| `HOST`, `PORT` | Default `127.0.0.1:3000`; use an SSH tunnel on Linode |
| `DATA_DIR` | Local database and draft evidence directory; default `data/` |

Environment variables take precedence over `.env`. Secret values can instead come from `AKAMAI_API_KEY_FILE`, `OBJ_ACCESS_KEY_FILE`, `OBJ_SECRET_KEY_FILE`, or the corresponding systemd credential files. Production mode disables `.env` loading. See [Ubuntu deployment and rollback](deploy/README.md).

## Real integrations

```text
Browser ── local connection / SSH tunnel ── Node.js on Ubuntu Linode
                                            ├─ Akamai Inference: structured review and change explanation
                                            ├─ Akamai Object Storage: private evidence JSON save/reopen
                                            └─ local data/: protocol versions, assignments, runs, draft evidence
```

Inference uses native `fetch` with bearer authentication, a 45-second timeout, bounded output, and the workshop's `json_schema` response format. It retries once without structured formatting only if the provider explicitly rejects that format. Authentication, rate-limit, and arbitrary upstream errors are not retried or shown verbatim. Truncated/invalid responses fail safely into the labeled local matcher.

Verification statuses are `documented`, `contradicted`, `insufficient_evidence`, and `needs_review`. Missing documentation does not establish that an operator skipped a step. Missing/duplicate/unknown SOP IDs, fabricated quotations, invalid log references, and uncited positive or contradictory claims become `needs_review`. Displayed quotations always come from the submitted source text. A valid citation proves a source line exists, not that the model interpreted it correctly.

The offline matcher supplies keyword suggestions only; it never certifies completion or rules out contradictions. Inference status says `configured` until a successfully parsed and validated model response has occurred in the current process.

Object Storage uses AWS SDK v3 Signature V4, path-style addressing, HTTPS, and `requestChecksumCalculation: WHEN_REQUIRED` / `responseChecksumValidation: WHEN_REQUIRED`, matching the workshop's compatibility guidance. No public ACLs or signed URLs are created. Keep the bucket private; all reads go through the server.

1. Verify a SOP/log pair. The server creates a UUID evidence packet locally with both sources, line mappings, findings, validator warnings, model metadata, and `human_review_required: true`.
2. Choose **Save evidence to Akamai**. The server saves its own packet, reads it back, and compares the exact bytes before reporting success. It does not trust a browser-supplied result or silently fall back after a cloud error.
3. **List saved evidence** or reopen by packet ID. Sources and the original result are fetched from the bucket with no inference request. This works after a restart and with an empty local data directory.
4. **Test storage connection** performs a real write/read/delete using a unique probe object. Successful read/write state resets on restart and changes to `error` if a later storage request fails.

The local protocol database remains `data/db.json`; this integration does not move it into Object Storage. Run one server process against a data directory. JSON writes use atomic replacement, and run submission reloads state after awaiting inference so it preserves concurrent assignment/protocol edits.

## Tests and live verification

```bash
npm run check
npm test
npm audit --omit=dev --audit-level=high
npm run smoke:live
```

`npm test` needs no credentials. It covers configuration and secret-file loading, inference formatting/fallback/timeouts, citation and status validation, existing protocol/assignment workflows, private evidence save/read-back/reopen with fresh local state, sanitized errors, and the actual AWS SDK's S3 HTTP signing and checksum behavior against a local fixture. GitHub Actions runs the suite on Ubuntu with Node 22 and 24.

`smoke:live` requires real inference and bucket credentials. It uses synthetic text, fails if inference falls back, tests cloud storage, saves/reopens one packet, and prints only success/failure summaries. It retains that synthetic packet in the private bucket. Through a running Linode tunnel use `npm run smoke:live -- --url http://127.0.0.1:3000`. A passing offline suite does **not** establish live Akamai connectivity.

## API additions

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Local liveness and current service status, without secrets |
| `GET /ready` | Local data directory read/write readiness; no cloud calls |
| `GET /api/config` | Existing inference configuration flag plus honest service state |
| `POST /api/verify` | Existing SOP/log review, now with `evidenceId` and human-review flag |
| `POST /api/evidence` | `{ "id": "UUID" }`: save the server's local packet and verify read-back |
| `GET /api/evidence?cursor=...` | Up to 100 saved packet IDs and a continuation cursor |
| `GET /api/evidence/packet?id=UUID` | Reopen a saved private packet without inference |
| `POST /api/storage/check` | JSON `{}`: write/read/delete a unique probe |

Protocol, assignment, run, and demo endpoints remain available. Verification status names were updated from the prototype's `verified/missed/unverifiable/deviation` to the documentation semantics above; the bundled UI uses the new names.

## Three-minute demo

1. **Protocol Builder / Assign**: save a new protocol version; show the hash and parent link. Assign the original version.
2. **Run**: submit a modified copy. Show the deterministic SHA-256 mismatch and, when configured, Akamai's explanation. An exact match needs no model.
3. **LabStrata Verify**: review Log B. Highlight source evidence and missing recorded values; do not describe absent documentation as proof of a skipped step. Model classifications may vary and must be reviewed.
4. **Evidence packets**: test storage, save the result, and note the UUID. Restart the server and reopen the UUID. Show that the model request ID is unchanged.
5. Explain the service boundary: Node on Linode, remote inference, private object persistence. Credentials are server-side. The `configured` and `operational` states are distinct.

## Reference and limits

This integration adapts the official [Akamai Seattle Hackathon workshop](https://github.com/akamai-developers/akamai-workshop-seattle-hackathon) at commit `e65a68b3264b6e0204b39cc74aa54b17403f5f30`, especially `01-inference/chat.mjs`, `01-inference/json_output.py`, `04-object-storage/storage.py`, and `02-linode/README.md`. The workshop is a reference; its Python app is not copied over LabStrata.

Use synthetic data for the demo. The application has no multi-user authentication and binds localhost by default. Public deployment needs authentication and HTTPS. Event inference keys expire; Object Storage billing continues until separately cancelled. No credentials, `.env`, generated data, or deployment secrets belong in Git.
