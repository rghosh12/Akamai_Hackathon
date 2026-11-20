# LabStrata

**Proof for every step of every lab run.** Photograph a handwritten (or typed) run log, and LabStrata checks it line by line against the exact approved SOP version. It shows every step that was *not documented*, cites the line that proves each finding, and seals the signed record where nobody can alter it.

Built for the Akamai Cloud buildathon, GitHub Bellevue, Nov 20 2026.

## The 30-second story
1. A scientist assigns an SOP; its version is pinned by SHA-256.
2. The operator scans a QR code, photographs the notebook page on a phone.
3. **Gemma** reads the page; **Qwen** compares it to the SOP. Numbers (tube masses, tolerance 0.1 g) are checked **in code**, not by the model.
4. The hero finding: **"Not documented: Step 4. Balance the rotor."**
5. A reviewer signs and **seals** it. Tampering is rejected by the storage layer itself (`AccessDenied`).

## How we use Akamai
| Akamai service | What depends on it |
|---|---|
| **Inference** (qwen3-8-27b, gemma-4-26b-a4b-it, qwen3-embedding-8b) | Reads the photo, verifies each SOP step, finds similar past findings, runs the calibration exam |
| **Managed PostgreSQL + pgvector** (private VPC) | Protocols, runs, findings, calibration, similar-finding search |
| **Object Storage** (capture bucket, presigned phone upload) | Notebook photos go phone → bucket directly |
| **Object Storage Object Lock** (COMPLIANCE) | Sealed run records. Deleting a version returns `AccessDenied` |
| **Linode ×2 + NodeBalancer** | Two app nodes; the balancer's health check reads `/calibration` |
| **VPC + Cloud Firewall** | Database and nodes are private; port 80 only from the balancer range |

## Inputs the model can't answer
- A photo it can't read becomes **"Unreadable: retake or rewrite"**, never a guess.
- A log that doesn't match the assigned SOP is reported as **"doesn't match"**.
- Every citation is re-checked against the source text; a missing or fake quote becomes `needs_review`.
- **Calibration gate:** the AI checker sits an exam on held-out cases. If it fails, reviews are paused and node B, deliberately running a worse prompt, drops out of the load balancer.

## Run locally
```bash
npm ci
cp .env.example .env     # add your keys locally; never commit .env
npm start                # http://localhost:3000, works offline with a local fallback
npm test
```

## Deploy on Akamai Cloud
```bash
node infra/provision.mjs   # lists the steps: buckets, vpc, db, firewall, linodes, deploy, nodebalancer
```
Details: `infra/README.md`. A scripted demo run lives in `demo-auto/`.

## Layout
`server.js` routes · `lib/verify.js` verify + code checks · `lib/vision.js` photo reading · `lib/calibration.js` exam gate · `lib/db.js` Postgres/pgvector · `lib/storage.js` buckets + Object Lock · `public/` UI and phone capture · `fixtures/calibration/` held-out cases · `deploy/` and `infra/` provisioning.

## Honest limits
Assistant for a qualified reviewer, not a replacement. Not validated for regulated manufacturing (21 CFR Part 11 work is future). Handwriting accuracy depends on photo quality.

Team: Alex (AI + screens) and Jonathan (cloud + proof), with Rupak's original LabStrata concept.
