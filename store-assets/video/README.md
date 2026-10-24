# Demo video

`promo.html` is the demo video as a web page: `render(t)` draws the frame at `t` seconds, so every
frame is exact. Open it in Chrome with `?t=12` to see one frame.

```sh
npm run video
```

This narrates the first sentences of the story with Kokoro (Heart voice), synthesizes a soft music
bed for the parts without narration, captures each frame in headless Chrome and encodes:

- `out/narro-demo-1080p.mp4`: for YouTube; the Chrome Web Store listing takes a YouTube link.
- `out/narro-demo-readme-720p.mp4`: a smaller copy, e.g. to drag into a GitHub issue or release.

It also updates what the README and landing page use, in `docs/`: `demo.mp4` (the 1080p video),
`demo.vtt` (captions), `demo-poster.jpg` (the landing page poster) and `demo-readme.jpg` (the
README's poster, with a play button, linking to the video on the landing page).

Needs Google Chrome (set `CHROME` to use another path) and `ffmpeg`. Takes about two minutes.

The highlight timing follows the narration, so you can edit the story text or the number of
sentences read (`READ` in `scripts/build-video.mjs`) without retiming anything by hand.

Fonts: [Inter](https://github.com/rsms/inter), SIL Open Font License 1.1 (`fonts/Inter-OFL.txt`).
