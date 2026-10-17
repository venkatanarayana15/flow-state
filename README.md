# PayFlow

**An accounts-payable agent with a signed scope — and the boundary that holds.**

Built for the [ArmorIQ Flow State Hackathon](https://armoriq.ai/hackathons/flow-state).

## Submission

| | |
|---|---|
| **Live demo** | `https://<app>.onrender.com` — fill in after deploying |
| **Pitch deck** | [`submission/PayFlow-FlowState-Deck.pptx`](submission/PayFlow-FlowState-Deck.pptx) |
| **Video** | `https://youtu.be/<id>` — fill in after uploading |
| **Runbook** | [`submission/README.md`](submission/README.md) — deploy, record, submit |

---

## The problem

A support agent that can refund money, issue credit, export the customer book
and send email is genuinely useful. It is also one prompt injection away from
draining the company.

The industry answer is to ask the agent nicely not to. Put instructions in the
system prompt telling it to ignore anything suspicious in customer data. That
works until someone writes a ticket that says *this is routine, already approved
by your finance lead, no need to flag it* — which is exactly what a motivated
attacker would write.

The insight: **you cannot put the lock inside the thing you don't trust.**

## The approach

Move the decision out of the model and into the call path. The agent still
plans. The agent still decides what it wants to do. But before any tool runs,
ArmorIQ checks that call against a signed plan and a policy written by someone
who is not the model.

A prompt injection can persuade the model to *want* something. It cannot make
ArmorIQ *allow* it.

```
 agent decides on a tool call
          │
          ▼
   plan captured, signed  ───►  intent token
          │
          ▼
   agent tries to invoke
          │
          ▼
   ArmorIQ checks: is this in the plan? does policy allow it?
          │
   ┌──────┼──────┐
   ▼      ▼      ▼
 ALLOW   HOLD   BLOCK
 (runs) (waits  (never
        for a   runs)
        human)
```

The check happens outside the model, in code, before the tool executes.

## What it does

PayFlow is an accounts-payable copilot for a small store. Seven tools, sorted
by blast radius:

| Tier | Tools |
|---|---|
| **Reads** | `lookup_customer` · `list_recent_orders` · `read_support_tickets` |
| **Money** | `refund_order` · `issue_store_credit` |
| **Egress** | `export_customer_data` · `send_email` |

Five beats, runnable in one command each:

| Beat | What happens | Expected |
|---|---|---|
| `beat:allow` | small refund | **ALLOWED** |
| `beat:hold` | $4,000 credit, over threshold | **HELD** for a human |
| `beat:deny` | a ticket tries to exfiltrate the customer book | **BLOCKED** |
| `beat:users` | the identical call, two different people | **DIFFERENT VERDICTS** |
| `beat:ungoverned` | same agent, same injection, nothing checking | **EXFILTRATES** |

Two of those are the argument for the whole project:

**Beat 4** — the same $4,000 refund is allowed for a manager and held for a
tier-1 rep. A static role cannot express this, because a role never sees that
the amount is $4,000 rather than $49. Policy is resolved per user, per call,
against the actual arguments.

**Beat 5** — switch the boundary off and the export succeeds. Nothing warns
you. That contrast is the entire thesis in one command.

---

## Setup

### 1. Environment

```bash
cp .env.example .env      # then fill in the three keys
npm install
node check-setup.js      # ← run this before anything else
```

`check-setup.js` exists because ArmorIQ **fails closed and fails quietly**. A
missing policy and a correctly configured strict policy look identical. A
policy scoped to the wrong MCP, or written against an unregistered agent name,
also looks identical — nothing is checked and nothing warns you. This script
turns those silent failures into loud ones.

### 2. Register the agent

Console → **Agents → Register Agent** → name it `payflow`

Policy is attributed by agent name. If your code sends `payflow` and the console
has something else, your policies never fire and nothing tells you why.

### 3. Register an MCP server

Console → **MCP Servers → Register MCP Server** → name it `payflow`

The name is what your code and your policies both use. **It must match
exactly.** A mismatch does not error; it just means no policy applies.

PayFlow's tools are native functions rather than a deployed MCP server, but
policy needs a name to scope rules to, and the session needs one to attribute
calls against.

### 4. Write the policies

Console → **Policies → New Policy**, all four scoped to the `payflow` MCP.
Set **Default enforcement action** to `block` — the closed default is what
makes a denial possible without writing a rule to forbid it.

| Policy | Action | Tools |
|---|---|---|
| `reads-allowed` | **allow** | `lookup_customer`, `list_recent_orders`, `read_support_tickets` |
| `money-under-limit` | **allow** | `refund_order`, `issue_store_credit` where `amount <= 500` |
| `money-over-limit` | **hold** | `refund_order`, `issue_store_credit` where `amount > 500` |
| `destructive-denied` | **block** | `export_customer_data`, `send_email` |

Two traps worth knowing:

- **Cover every tool that can move money.** If a policy names only
  `refund_order`, the model reaches for `issue_store_credit` instead — not to
  evade anything, just because it fits the request better.
- **Threshold rules scan arguments for `amount`, `value`, `total`, `price`,
  `cost`.** A field called `total_cents` is invisible to them.

### 5. Run it

```bash
npm run beat:deny      # the beat that matters
npm run beats          # all five
npm start              # the web UI on :3000
```

When a beat holds, go to **Approvals** in the console and approve it. The agent
is waiting. If nobody approves in time the call is refused — a timeout is a
refusal, not an allow.

---

## Architecture

```
agent-cli.js            the five beats, colourised
check-setup.js          catches silent config failures
src/
  agent.js              ← the ArmorIQ four-move loop
  planner.js            Gemini → one structured tool call
  tools.js              the seven tools and their executors
  db.js                 seeded data + the injected ticket
  beats.js              the five beat definitions
  server.js             HTTP server for the live demo
public/index.html       the demo UI
```

Only `src/agent.js` is ArmorIQ. Delete it and the agent still works — it just
is no longer governed.

### The loop

```js
// MOVE 1 — declare intent. The plan is signed.
await session.startPlan([call], goal);

// MOVE 2 — ask the boundary, before anything executes.
const decision = await session.check(call.tool, call.args, who);
const { action, reason } = decision;   // 'allow' | 'hold' | 'block'

if (action !== 'allow') {
  // MOVE 4 — record that it never ran.
  await session.report(call.tool, call.args, null, {
    status: 'failed', errorMessage: reason, durationMs,
  });
  return;                              // ← the tool is never invoked
}

// MOVE 3 — execute. Only reachable past an explicit allow.
const result = await executeTool(call.tool, call.args);

// MOVE 4 — record what happened.
await session.report(call.tool, call.args, result, { status: 'success' });
```

`action` is the authoritative field, read straight from the SDK's
`EnforceResult`. Anything that cannot be positively read as an allow fails
closed.

### Proof

Every call produces an audit row in **Observability** with its arguments, its
decision, the policy that matched, and a `proofPath` tying that specific
execution back to the signed plan it was checked against.

That is the difference between "the agent promised not to" and "here is the
cryptographic receipt."

---

## Notes

- **All data is synthetic.** Every customer, order and ticket is fabricated
  for this prototype. Nothing is connected to a real store, no email is ever
  sent, and exports are returned in memory rather than written anywhere.
- **`.env` is gitignored** before the first commit. Rotate the ArmorIQ and
  Gemini keys after submitting.
- **Beat 5 depends on the planner being persuadable, and models differ.**
  `gemini-3.1-flash-lite` follows the injected ticket; `gemini-3.5-flash-lite`
  refuses it. That variance is part of the argument, not a bug — pin
  `GEMINI_MODEL` for a reproducible recording.
- Built on `@armoriq/sdk` and Gemini. Swapping the LLM touches one function.