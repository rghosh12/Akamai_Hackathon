# demo-auto

```bash
cd demo-auto && npm install && npx playwright install chromium && cd ..
bash demo-auto/reset.sh && node demo-auto/run-demo.mjs   # -> demo-auto/out/labstrata-demo.mp4
bash demo-auto/live.sh                                    # live, headed, no recording
```

Needs: `.env` with `PUBLIC_URL`, `LINODE_TOKEN`, `ADMIN_TOKEN`; `infra/state.json` + `infra/keys/` from `infra/provision.mjs`;
`demo-auto/assets/notebook-page.jpg` (handwritten SOP-EQ-014 page, Step 4 masses missing) and optionally
`demo-auto/assets/notebook-unreadable.jpg`. ffmpeg on PATH for the mp4 (otherwise the raw .webm is kept).
Optional narration: put `demo-auto/out/narration.mp3` (ElevenLabs "Dean", one line per beat from `script.md`).

## UI hooks for the UI lane (`data-demo` attributes)

The script looks for these first and falls back to visible text, so adding them makes the run deterministic:

| hook | element |
|---|---|
| `tab-assign`, `tab-verify` | nav tabs |
| `assignee`, `assign-button` | assign form |
| `capture-qr` | QR code for `/capture/:assignmentId` |
| `capture-submit` | upload button on the phone page (`/capture/:id`, page must say "uploaded" when done) |
| `load-photo` | loads the latest captured photo + Gemma read into Verify |
| `read-lines` | Gemma's read lines beside the photo |
| `verify-button` | runs Verify |
| `finding` + `data-status="<status>"` | each finding row |
| `reviewer`, `sign-button` | sign form; page shows "sealed" when done |
| `tamper-button` | "Try to alter this record"; page shows the `AccessDenied` code and "Original intact" |
| `share-button`, `share-link` | auditor link (`<a href>` or readonly `<input>`) |
| `calibration-badge` | badge |
| node B UI | must say "Reviews paused" when `/api/verify` returns 503 `{paused:true}` |
