# LabStrata demo: one caption / narration line per beat

Pitch on screen first: "Did they follow the procedure? Photograph a lab notebook page, and LabStrata checks it against the exact approved SOP version, shows any step that wasn't documented with the line that proves it, and seals the record so nobody can change it."

1. Someone skipped weighing the tubes. An unbalanced centrifuge can tear itself apart. Failing to follow written procedures was the FDA's most cited drug-inspection finding: at least 243 times in fiscal 2025.
2. The lab manager assigns one exact, hashed version of the centrifuge SOP. The operator scans the code, photographs the notebook page, and the photo uploads straight from the phone to Akamai storage.
3. A vision model on Akamai reads the handwriting line by line, right beside the photo, so a person can check every digit.
4. Step 4, balance the rotor, was never documented, so it counts as not done. The tube masses, temperature and speed are checked by code, not by the model.
5. A qualified reviewer signs, and the record is sealed in locked storage. Even we cannot delete or change it: the attempt is refused and the original stays intact.
6. An auditor gets a read-only link to the sealed record that expires in 24 hours.
7. The AI must pass its exam before the load balancer lets it grade anyone's work. A worse prompt on server B fails the exam, so reviews pause there instead of passing bad results.
8. When it can't answer, it says so: an unreadable page gets "retake", and a log for the wrong procedure gets "doesn't match".
9. A pinned model version, zero data retention, and a human signs every record. LabStrata, on Akamai Cloud.
