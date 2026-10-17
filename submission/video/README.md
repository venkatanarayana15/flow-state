# PayFlow — how the demo video was made

The submitted video is [`../PayFlow-demo.mp4`](../PayFlow-demo.mp4): 1920×1080,
30 fps, H.264 + AAC, **4:19**, 11.4 MB. It is generated from four inputs and
nothing else:

| Input | What it supplies |
|---|---|
| `captures.json` | the exact stdout of two real runs and the real test suite |
| `shots/*.png` | real screenshots of the light UI, taken while it ran |
| `scenes.mjs` | the narration text, the frame layouts, the captions |
| `stage.html` | the 1920×1080 stage the frames are painted on |

There are no hand-edited frames and no video editor in the loop. Position the
video in the build with the **frame clock**, not the pointer.

## The cut

| Time | Scene | Shows |
|---|---|---|
| 0:00 | title | |
| 0:07 | ticket | the injection inside a normal support ticket |
| 0:20 | audience | who the agent is for |
| 0:36 | problem | why prompt-level defences fail |
| 1:03 | tools | the seven tools by blast radius |
| 1:17 | code | the four-move loop in `runGoal()` |
| 1:35 | ui-product | the app: goal · identity · boundary |
| 1:49 | ui-blocked | governed run — refused before the tool |
| 2:06 | ui-free | control run — export, email, counters move |
| 2:23 | raw stdout | the control run's terminal output |
| 2:39 | deny | the governed run's terminal output |
| 2:57 | console | agent · MCP · Policy Studio in ArmorIQ |
| 3:14 | policy | the four rules and their effects |
| 3:34 | tests | 46 tests, fail-closed verdicts |
| 3:49 | takeaways | what we learned, what is next |
| 4:11 | repo | source |

## Rebuild

```bash
npm start                                   # the UI, on :3000 or PORT
node submission/video/ui-shots.mjs          # drive the UI, verify, screenshot
node submission/video/capture.mjs --force   # re-run the CLI beats + tests
node submission/video/render.mjs            # narrate, paint, encode
```

`ui-shots.mjs` is a check first: it fails on a console error, a failed request,
a missing verdict, a clipped block, or horizontal overflow at 390px. If it
passes, the screenshots in `shots/` are the app's own pixels, and those files
are what the video shows.

`render.mjs` writes `submission/PayFlow-demo.mp4` and leaves intermediate frames
in `build/` (git-ignored). Narration is cached in `audio/`, keyed by a hash of
the line, so editing a sentence cannot silently reuse the old take.

Requirements: Node 18+, `python` with `edge-tts`
(`python -m pip install edge-tts`), Chrome (driven through Playwright), and a
full ffmpeg — `ffmpeg-static` in `~/.payflow-tools` is found automatically, as
is one in `PATH`.

## What keeps it honest

- `capture.mjs` refuses to save a capture whose run failed or whose output does
  not contain the fact the video claims (`exported:true`, `check BLOCKED`,
  `fail 0`). A broken run stops the build instead of becoming a nice-looking
  frame.
- `ui-shots.mjs` refuses to keep a screenshot unless the UI showed the verdict
  it claims (`BLOCKED` for the governed run, the export delta for the control).
- Terminal text is rendered from the captured bytes, with the ANSI colours
  parsed into CSS classes. Nothing is retyped.
- `scenes.mjs` throws if a screenshot is missing, so a build cannot quietly
  ship a broken image.
- `render.mjs` measures every frame after painting it. Text that would overflow
  is scaled down, and anything under 15px fails the build.
- The governed scenes carry a footnote naming the real state of the workspace
  they were captured on: the staging account had no MCP server or policy set
  attached, so the check refused at the first call (`agent_unresolved`) instead
  of reaching the export. See [`../POLICY-STUDIO.md`](../POLICY-STUDIO.md).

## Known limits

- Narration is synthesized (`en-US-AndrewNeural`), not a human voice.
- The console scene is a labelled schematic of the console objects, not a
  screenshot: the console needs a logged-in session. The Policy Studio scene is
  the rule set the app is built against, with the account state printed on
  screen.
- Re-running `capture.mjs` re-runs Gemini, so the planner's rationales and its
  exact choice of steps differ between captures. The verdicts and the export do
  not.
