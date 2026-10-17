# Video — the cut that ships

[`submission/PayFlow-demo.mp4`](submission/PayFlow-demo.mp4) is the submitted
video: **4:19**, 1920×1080, 30 fps, H.264 + AAC, narrated, captions on every
frame. It is generated from real runs — this file is the chapter list so you can
follow it, or re-record it in your own voice.

| Time | Chapter | What is on screen |
|---|---|---|
| 0:00 | cold open | PayFlow, the promise: the boundary that holds |
| 0:07 | the input | ticket NW-T-3391 — a real complaint, then an instruction aimed at the agent |
| 0:20 | who it is for | accounts payable, support ops, anyone shipping an agent with a refund button |
| 0:36 | the problem | you cannot put the lock inside the model you do not trust |
| 1:03 | the surface | seven tools, split by blast radius: 3 reads, 2 money, 2 egress |
| 1:17 | the loop | `startPlan` → `check` → execute → `report`, in `src/agent.js` |
| 1:35 | the product | the light UI: goal, identity, boundary switch, five scenarios |
| 1:49 | boundary on | the injected ticket is refused before the tool runs; counters stay at zero |
| 2:06 | boundary off | the identical agent exports six customer records; counters move |
| 2:23 | the control, in full | real stdout: `"exported":true`, six rows, outside address |
| 2:39 | the refusal | real stdout: `check BLOCKED`, `agent_unresolved`, nothing executed |
| 2:57 | the console | agent, MCP server, Policy Studio — what the SDK bootstraps against |
| 3:14 | the rules | the four rules, their effects, and the account state of this workspace |
| 3:34 | proof | 46 tests, including the fail-closed verdict shapes |
| 3:49 | takeaways | three lessons, and what we would build next |
| 4:11 | the repo | where the code, rules and this video live |

## The argument, in the narration

1. The instruction arrives as **data the agent reads**. Reading it is the job.
2. The model is the untrusted part, so the decision moves **outside it**, into
   the call path, before the tool runs.
3. A refusal must be **recorded**, or a block and a crash look the same.
4. The **control run** — same agent, nothing checking — is what makes the
   boundary legible.

## What the video does not claim

- The governed run was recorded on a staging workspace with **no MCP server and
  no policy set attached**, so the check refused at the first call
  (`agent_unresolved`) instead of at the export. The frame and the Policy
  Studio scene say so on screen; the narration claims only what the capture
  contains.
- The console scene is a labelled schematic of the console objects, not a
  screenshot — the console needs a logged-in session.
- The voice is synthesized (`en-US-AndrewNeural`), not a human recording.

## Re-record it in your own voice

1. Run the build so the frames exist: `node submission/video/render.mjs`.
2. Read the narration for each scene — it is the `narration` string in
   [`submission/video/scenes.mjs`](submission/video/scenes.mjs), in chapter
   order.
3. Record at 1920×1080 with the same chapter order, or capture the screen while
   the real UI runs: `npm start`, pick a scenario, let the trace stream.
4. Keep it under five minutes, upload as **unlisted**, and put the URL in
   `submission/links.json` and field 4 of `submission/SUBMISSION.md`.

The one thing worth keeping from the generated cut: show the **control run**
next to the governed one. The contrast is the argument.
