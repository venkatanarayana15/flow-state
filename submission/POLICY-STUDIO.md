# Policy Studio — the four rules

PayFlow only demonstrates what ArmorIQ can decide if the workspace has an agent,
an MCP server and rules attached to it. This page is the exact set to create at
**tools.armoriq.ai → Policy Studio**, and the state of the workspace the demo
video was recorded on.

> **Account state for the recording in `PayFlow-demo.mp4`:** the staging
> workspace had a working API key but no MCP server and no policies, so every
> governed call was refused at the first `check` with `agent_unresolved`. That
> is correct fail-closed behaviour, not a bug in the app — the tool never ran.
> The UI, the refusal and the ungoverned comparison are real; the ALLOW and HOLD
> verdicts cannot appear until the rules below exist.

---

## The rules

All four are scoped to the MCP server `payflow` (the name in
`ARMORIQ_MCP_NAME`). Tool names are matched exactly as they appear in
`src/tools.js`.

| Rule | Applies to | Condition | Effect |
|---|---|---|---|
| `reads-allowed` | `lookup_customer`, `list_recent_orders`, `read_support_tickets` | — | **allow** |
| `money-under-limit` | `refund_order`, `issue_store_credit` | `amount <= 500` | **allow** |
| `money-over-limit` | `refund_order`, `issue_store_credit` | `amount > 500` | **hold** |
| `destructive-denied` | `export_customer_data`, `send_email` | — | **block** |

The threshold rules read number fields named `amount`, `value`, `total`, `price`
or `cost`. A field called `total_cents` is never seen, and a rule that matches on
the tool name alone would allow a $4,000 credit as easily as a $49 refund —
which is the point of beat 2.

## What each rule is for

| Rule | Beat it decides | What a judge should see |
|---|---|---|
| `reads-allowed` | 1, 3 | The lookup and the ticket read succeed, so the agent can do the job at all |
| `money-under-limit` | 1 | A $68 refund for a broken zip completes |
| `money-over-limit` | 2, 4 | A $4,000 credit is held for a human instead of executed |
| `destructive-denied` | 3 | The bulk export never runs, even though the ticket asks for it |

With this set in place, `npm run beats` prints:

```
allow       → completed     (refund executed)
hold        → held          (nothing moved)
deny        → blocked       (nothing moved)
users       → the same goal judged per identity
ungoverned  → completed, and the export went out anyway
```

## Create them

1. Sign in at **tools.armoriq.ai** with Flow State Pro (`FLOWSTATEPRO`).
2. **MCP Servers → Register**: name `payflow`, expose the seven tools from
   `src/tools.js` (schemas are in `TOOLS[].parameters`).
3. **Agents → Register**: name `payflow` (or set `ARMORIQ_AGENT_NAME` to the one
   you have — a mismatch means no policy fires and no warning is printed).
4. **Policy Studio → New Policy**: add the four rows above, scoped to `payflow`.
5. Confirm from this machine:

```bash
node check-setup.js        # expects every line OK
npm run beats              # expects all five verdicts
```

Only then re-record the demo. The governed run in the video will then refuse at
the export (step 3) instead of at the first read:

```bash
node submission/video/capture.mjs --force
node submission/video/ui-shots.mjs      # server must be running on :3111
node submission/video/render.mjs
```

## Why the workspace state is printed, not hidden

A missing policy and a strict policy both produce a refusal, so a demo can look
identical whether the boundary is configured or absent. ArmorIQ fails closed and
fails quietly; the recording says which failure this was. `check-setup.js` turns
that silence into explicit `OK` / `FAIL` lines, and `submission/SUBMISSION.md`
records the account state as of the last check.
