# Flow State — submission form answers

Copy each block straight into the form. Fields marked **⚠ needs you** cannot be
produced from this machine.

Event: **Flow State — Global AI Hackathon**, by ArmorIQ · 10–17 Oct 2026
Theme on the listing: **AI Agents, MCP & Agent Security**
Format: solo or teams up to 4 · submit a working project + a short demo

---

## 1. Project Name

```
PayFlow
```

## 2. Project Description

Short version (form-friendly, ~90 words):

```
PayFlow is an accounts-payable agent for a fictional store. It plans real
work — lookup a customer, refund an order, issue store credit, send email,
export data — and every single tool call is checked against a signed scope
before it is allowed to touch anything.

The demo runs the same agent twice. Asked to resolve a support ticket whose
text hides a bulk data-export request, the governed agent stops at the
boundary: nothing exported, nothing sent. With the boundary switched off, the
identical run exports the customer book. That contrast is the product.
```

Long version (~250 words, for a description box that allows it):

```
PayFlow is a governed accounts-payable agent, built on ArmorIQ for the Flow
State hackathon and themed on AI agents, MCP and agent security.

The agent has seven real tools split by blast radius: three safe reads
(customer lookup, recent orders, support tickets), two money writes (refund an
order, issue store credit) and two egress channels (bulk customer export, send
email). A Gemini-backed planner turns a natural-language goal into one
structured tool call at a time and reads support-ticket text as part of the
job — deliberately, the way most support agents are actually built. That is
the threat model, not a bug.

Every call then passes ArmorIQ's four-move loop: startPlan declares and signs
the intent, check asks the boundary, the tool executes only on an explicit
allow, and report records what actually happened — including refusals that
never executed.

Five scripted beats prove the boundary. Routine work is allowed. A $4,000
store credit over the limit is held for a human. A ticket that asks the agent
to hand over the customer master file is blocked before the export runs. The
identical $4,000 call gets a different verdict for a different identity,
because policy is resolved per user, not per role. And with enforcement off,
the same agent, ticket and injection export six customer records — the
control that shows what the boundary is actually preventing.

Nothing moves on a blocked call. No money, no email, no data leaves the
process: side effects are simulated in memory so a judge can verify every
claim by eye.
```

## 3. GitHub / Repo URL

```
https://github.com/venkatanarayana15/flow-state
```

## 4. Video Link

**⚠ needs you.** The demo needs your voice and five live runs; see
[`../VIDEO_SCRIPT.md`](../VIDEO_SCRIPT.md) (4:30, five beats, not slides).
Upload as an unlisted YouTube video, then put the URL here and in
[`links.json`](links.json).

```
<paste the video URL>
```

## 5. Idea Name

```
The boundary that holds
```

One line if the form wants the idea, not the product:

```
PayFlow — the boundary that holds: a payment agent that can only act inside
a signed scope, and the proof that it stops when it leaves one.
```

## 6. Theme / Track Selection

```
AI Agents, MCP & Agent Security
```

If the form splits MCP out as its own track, submit under **Agent Security** —
that is where this project competes. The agent talks to seven tools through a
typed tool surface and every call is mediated by ArmorIQ, so **AI Agents** also
applies. Pick the security track if only one is allowed.

## 7. Deployed URL

**⚠ needs you.** The blueprint is ready ([`../render.yaml`](../render.yaml));
creating the host account is the missing step. Free-plan Render is enough —
see [`README.md`](README.md) step 2.

```
https://<app>.onrender.com
```

## 8. Presentation File (PDF)

```
submission/PayFlow-FlowState-Deck.pdf
```

13 slides, 16:9, speaker notes on every slide. Regenerate after any change:

```bash
python submission/build_deck.py && python submission/export_pdf.py
```

---

## What the organiser asks you to demonstrate

The listing says the project should show three things. Where each is answered:

| Requirement | Where it is answered |
|---|---|
| What the agent does | Deck slides 3–5 · the seven-tool surface in `src/tools.js` |
| How ArmorIQ is used | Deck slide 6 · `runGoal` in `src/agent.js` (plan → check → execute → report) |
| How the boundary is maintained | Deck slides 7–11 · the five beats in `src/beats.js`, `npm run beats` |

## Evidence a judge can check without trusting a slide

| Claim | How to check it |
|---|---|
| A blocked call never executes | `npm run beat:deny` — the tool never runs, the attempt is still recorded |
| The same call differs per user | `npm run beat:users` — identical goal, two identities |
| The boundary is what prevents the export | `npm run beat:ungoverned` — same agent, injection succeeds |
| Nothing real moves | `src/tools.js` — ledger, outbox and export log are in-memory arrays |
| Verdicts fail closed | `npm test` — 46 tests, 15 of them on unrecognised decision shapes |

## Before you hit submit

- [ ] `node check-setup.js` exits 0 (see the account blockers below)
- [ ] `npm run beats` shows allow → completed, hold → held, deny → blocked
- [ ] Repo is public and the pushed commit contains `submission/`
- [ ] `git ls-files | grep -c '^\.env$'` prints 0 — no secrets in the repo
- [ ] Live URL opens and `/api/health` returns `ok: true`
- [ ] Video is under 5 minutes, unlisted, and audible
- [ ] `links.json` has the live and video URLs, and the deck/PDF are rebuilt

## Account state as of the last check

`node check-setup.js` → exit 1. The key authenticates (staging backend) and the
governed call path runs end to end, but the account is missing two things, both
createable in the ArmorIQ console in a few minutes:

1. agent `payflow` is not registered — only `opencode` exists
2. no MCP server, so **no policies**, so every governed call returns
   `no_active_policy` (correct fail-closed behaviour, but beat 1 would show
   BLOCKED instead of ALLOWED)

Create those, then `npm run beats` produces all five verdicts as written.

### Beat 4 and the single-email problem

The two demo identities are resolved per address, and the second one does not
need its own account: `client.resolveUser()` on staging returns
`isMember: false` for an unknown address instead of rejecting it. So
`ARMORIQ_USER_EMAIL_LOW` is set to `venkatnarayana727+tier1@gmail.com` — an
alias of the same inbox.

**Unverified:** whether that non-member actually receives a different verdict
from the admin. Run `npm run beat:users` once the policies exist. If both runs
print the same verdict, drop beat 4 from the deck and the script rather than
showing a comparison that cannot differ.
