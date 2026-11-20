# LabStrata

Scientists build protocols, assign one exact version to someone, and check whether the protocol that was actually run is the one that was assigned. **LabStrata Verify** compares a run log against the SOP with Akamai Inference Cloud and cites the SOP line for each finding.

## Run it

Requires Node 18 or later. There are no dependencies.

```bash
cp .env.example .env    # fill in AKAMAI_BASE_URL, AKAMAI_API_KEY, AKAMAI_MODEL
node server.js          # http://localhost:3000
```

Akamai Inference exposes an OpenAI-compatible API. Set `AKAMAI_BASE_URL` to the base URL that ends in `/v1`; LabStrata adds `/chat/completions` to it. Without `.env`, the app runs an offline keyword matcher instead. The UI labels it clearly as **not Akamai**, so the demo still works if the network drops.

To reset demo data, delete `data/db.json`. It is reseeded with the centrifuge protocol on the next start.

## Where Akamai Inference Cloud is used

| Feature | What the model does | What LabStrata does without the model |
|---|---|---|
| LabStrata Verify (`POST /api/verify`) | Reads the line-numbered SOP and run log. Returns each requirement marked verified / missed / unverifiable / deviation, with the SOP line and the log line it relied on. | Checks each quote the model gives against the actual source line. A quote that doesn't match is shown as "citation unconfirmed". |
| Protocol integrity (`POST /api/runs`) | When the hashes differ, explains what changed in each step and rates how much it matters. | Exact match uses SHA-256 over the canonical protocol content, so it never depends on the model. |

Every Akamai result shows the endpoint host, model, request ID, latency and token counts in the UI.

## 3-minute demo script

1. **Protocol Builder**: open the seeded SOP-EQ-014 protocol. Point out the instruction, timer, question and required-field components. Edit something and save to get v2 with a new hash and a parent link.
2. **Assign**: assign v1 to "M. Chen". The assignment pins that hash.
3. **Run**: tick *Simulate a locally modified copy* and submit. The result is a hash mismatch, a step-by-step diff (spin time halved, balance tolerance loosened), and Akamai's impact rating. Untick it and submit again to get a match.
4. **LabStrata Verify**: the SOP and **Log B** are preloaded. Click *Verify with Akamai Inference Cloud*. Expected results:
   - **Missed**: SOP line 7 (Step 4, balance the rotor and record tube masses). The log never mentions it.
   - **Unverifiable**: line 5 (no rotor serial, only "Rotor looks fine") and line 6 (no temperature value, only "Chamber cold").
   - Click a row to highlight the SOP line and the log line side by side.
5. Switch to **Log A**: everything is verified.

## Files

- `server.js`: API, version hashing, Akamai client, citation checks, offline fallback
- `public/`: UI (plain HTML and JS)
- `demo/`: the SOP and two sample run logs
