# PayFlow — how the demo video was made

The submitted video is [`../PayFlow-demo.mp4`](../PayFlow-demo.mp4): 1920×1080,
30 fps, H.264 + AAC, 2:21, 6.3 MB. It is generated from three inputs and nothing
else:

| Input | What it supplies |
|---|---|
| `captures.json` | the exact stdout of two real runs and the real test suite |
| `scenes.mjs` | the narration text, the frame layouts, the captions |
| `stage.html` | the 1920×1080 stage the frames are painted on |

There are no screenshots to go stale and no video editor in the loop. Position
the video in the build with the **frame clock**, not the pointer.

## Rebuild

```bash
node submission/video/capture.mjs --force   # re-run the CLI beats + tests
node submission/video/render.mjs            # narrate, paint, encode
```

`render.mjs` writes `submission/PayFlow-demo.mp4` and leaves the intermediate
frames and audio in `build/` and `audio/` (git-ignored).

Requirements: Node 18+, `python` with `edge-tts`
(`python -m pip install edge-tts`), Chrome (painted through Playwright), and a
full ffmpeg — `ffmpeg-static` in `~/.payflow-tools` is found automatically, as
is one in `PATH`.

## What keeps it honest

- `capture.mjs` refuses to save a capture whose run failed or whose output does
  not contain the fact the video claims (`exported:true`, `check BLOCKED`,
  `fail 0`). A broken run stops the build instead of becoming a nice-looking
  frame.
- Terminal text is rendered from the captured bytes, with the ANSI colours
  parsed into CSS classes. Nothing is retyped.
- Lines are filtered to the readable ones and truncated for width; the kept
  lines are verbatim, and `scenes.mjs` says so in the frame footnote.
- `render.mjs` measures every frame after painting it. Text that would overflow
  is scaled down, and anything under 15px fails the build — unreadable text is
  treated the same as missing text.
- The deny scene carries a footnote naming the real state of the workspace it
  was captured on, because the run refused at the first call. The video never
  shows a verdict the capture does not contain.

## Known limits

- Narration is synthesized (`en-US-AndrewNeural`), not a human voice.
- The control run is shown in two frames of the same run (reads, then the calls
  that move data) so the terminal stays legible; each frame repeats the run
  header so the excerpt is unambiguous.
- Re-running `capture.mjs` re-runs Gemini, so the wording of the agent's
  rationales will differ between captures. The verdicts will not.
