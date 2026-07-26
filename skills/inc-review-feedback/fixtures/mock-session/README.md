# Mock feedback session — triage test fixture

A deterministic input for exercising the `inc:review-feedback` extensive path end to end, over and over, without a recording, transcription, or a live collector session.
It simulates a reviewer session on a fictional "Recipe Box" dashboard and is deliberately built so every triage bucket and every cross-cutting rule in `references/feedback-triage.md` appears at least once.

## Contents

- `notes.md` — the "spoken" narration (the analyzer's meeting-notes input; no whisper needed).
- `annotations.json` — three written click-comment pins (the collector sidecar format).
- `expected-triage.md` — the answer key: expected bucket per item and the rule each item exercises.

## Run it

```bash
python3 "<plugin root>/skills/inc-review-feedback/scripts/analyze_riffrec_zip.py" \
  "<plugin root>/skills/inc-review-feedback/fixtures/mock-session/notes.md" \
  --annotations "<plugin root>/skills/inc-review-feedback/fixtures/mock-session/annotations.json" \
  --output-dir /tmp/mock-feedback-run
```

Then follow the extensive-analysis reference as if this were a real session: synthesize requirements, run the triage (step 8d), fill the report.
Because the input is a notes file there are no frames or timestamps - visual sections will say so, which is expected.

## Grade a run

Compare the produced triage table against `expected-triage.md`.
The answer key states pass criteria; the two items that require verification (header-height memory, empty-state reachability) must show a verification attempt rather than a silent `change` tag - this fixture ships no product source, so both should end flagged, not implemented.

Delete `/tmp/mock-feedback-run` between runs; every run is independent.
