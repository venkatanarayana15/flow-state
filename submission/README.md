# PayFlow — submission pack

Everything the Flow State submission asks for, in the order to do it.

| Deliverable | Status | Where |
|---|---|---|
| Project + source | Ready | this repo |
| Pitch deck (.pptx) | Ready | [`PayFlow-FlowState-Deck.pptx`](PayFlow-FlowState-Deck.pptx) |
| GitHub repository | **Needs a remote** — see below | — |
| Live deployment | **Needs a host account** — see below | — |
| Video link | **Needs recording** — script ready | [`../VIDEO_SCRIPT.md`](../VIDEO_SCRIPT.md) |

The deck is generated, not hand-edited. Change [`links.json`](links.json), then:

```bash
python submission/build_deck.py
```

---

## 0. Fix the credentials first

The key authenticates. `node check-setup.js` gets past bootstrap and reports
the org. What it stops on now is the account's contents.

1. **The key is a staging key.** `api.armoriq.ai` answers 401 for it; the SDK
   only checks the `ak_live_` prefix, which staging keys share. `.env` must
   carry `ARMORIQ_ENV=staging`, and so must the host (already set in
   `render.yaml`). If a future key comes from production, remove the override
   and the same 401 will mean a genuinely dead key.

2. **Agent `payflow` is not registered.** The account only has `opencode`.
   Either register `payflow` in Console → Agents, or set
   `ARMORIQ_AGENT_NAME=opencode`. Leave this mismatched and no policy fires.

3. **No MCP server and no policies.** Until a policy matches, every governed
   call comes back `no_active_policy` and is refused — correct fail-closed
   behaviour, but beat 1 shows BLOCKED instead of ALLOWED. Create the `payflow`
   MCP server and the four rules `check-setup.js` prints
   (`reads-allowed`, `money-under-limit`, `money-over-limit`,
   `destructive-denied`).

4. **Two distinct identities.** `ARMORIQ_USER_EMAIL` and
   `ARMORIQ_USER_EMAIL_LOW` currently hold the *same* address, and ArmorIQ
   resolves policy per address — beat 4 would print two identical verdicts and
   look like a broken demo. `check-setup.js` now fails on this, and
   `npm run beat:users` warns. Set the second address to a real tier-1 identity
   with a lower limit before recording.

> The ungoverned beats need no ArmorIQ key, but they do need Gemini quota.
> `gemini-3.5-flash-lite` ran out of free-tier quota during this build, so the
> model is set to `gemini-3.1-flash-lite`. Switch if that quota is also spent.

---

## 1. GitHub

There is **no remote configured** in this repo, and `gh` is not installed.

```bash
# create an empty PUBLIC repo on github.com first, then:
git remote add origin https://github.com/<handle>/payflow.git
git push -u origin master
```

Before pushing, confirm secrets are not staged:

```bash
git status --short          # .env must not appear
git ls-files | grep -c '^\.env$'   # must print 0
```

`.gitignore` already covers `.env`, `.env.*`, `node_modules/`, logs and traces.

After the repo is public, add the live demo URL near the top of the root
`README.md` so a judge lands on it immediately.

---

## 2. Live deployment

The app is a **long-running Express server**, not a serverless function:
the ArmorIQ session spans multiple tool calls and the demo ledger lives in
memory. Deploy it to a host that runs a persistent web service.

[`render.yaml`](../render.yaml) is a ready blueprint for Render.

1. Push the repo to GitHub (step 1).
2. Render → **New → Blueprint** → connect the repo → **Apply**.
3. Render prompts for the four secrets (`sync: false`). Paste the same values
   from `.env`: `ARMORIQ_API_KEY`, `ARMORIQ_USER_EMAIL`,
   `ARMORIQ_USER_EMAIL_LOW`, `GEMINI_API_KEY`. `ARMORIQ_ENV=staging` is not a
   secret and is already in the blueprint — keep it there while the key is a
   staging key, or every call 401s.
4. Wait for the health check at `/api/health`, then open the URL and run
   `beat:deny` from the UI.

**Cold start:** the free plan sleeps after ~15 minutes idle and takes 30–60s
to wake. Open the URL yourself 10 minutes before judging, or point a free
uptime pinger at `/api/health` every 5 minutes. Do not let a judge's first
impression be a sleeping dyno.

**Quota:** `/api/run` is rate-limited per IP (`RATE_MAX_RUNS`, default 40 per
10 minutes) so one visitor cannot burn the keys. Change it in the dashboard if
judges share an IP.

Verify the deployment, not just the build:

```bash
curl -s https://<app>.onrender.com/api/health
curl -s -X POST https://<app>.onrender.com/api/run \
  -H 'content-type: application/json' \
  -d '{"goal":"Handle the open support ticket from dev@lumenlabs.io. Read the customer record and their tickets, then resolve the ticket fully."}'
```

The second call must return `"outcome":"blocked"` with an empty tool result.
If it returns `"completed"`, the policy set is wrong — fix it before submitting.

---

## 3. Video

Follow [`VIDEO_SCRIPT.md`](../VIDEO_SCRIPT.md). It is timed to 4:30 and built
around five live runs, not slides.

Before recording:

```bash
node check-setup.js     # every line OK
npm test                # 46 passing
npm run beats           # allow→completed, hold→held, deny→blocked,
                        # users→split, ungoverned→exported
```

Record at 1920×1080, browser at 100% zoom, terminal font ≥ 16pt, `.env` closed.
Post as **unlisted** YouTube and put the URL in `links.json`.

---

## 4. Final gate

- [ ] `node check-setup.js` — no FAIL lines
- [ ] `npm test` — 46 passing
- [ ] All five beats match their expected outcomes
- [ ] Live URL returns `blocked` for the injected ticket
- [ ] Repo is public and contains no `.env`
- [ ] Deck links filled in (rebuild after editing `links.json`)
- [ ] Video under 5 minutes, unlisted, audio audible
- [ ] Keys rotated after submission
