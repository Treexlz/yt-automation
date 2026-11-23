# yt-automation

Script-driven animated map videos for alternate-history Shorts, TikToks and long-form YouTube.

You write (or draft with Claude) an **episode script** in JSON: the narration, plus what the map should do in each scene. The pipeline voices it, times everything to the voiceover and renders:

- `out/<episode>-short.mp4`: 1080×1920 for Shorts, TikTok and Reels
- `out/<episode>-long.mp4`: 1920×1080 for regular YouTube

## Setup (once)

You need **Node.js 18+**, **Python 3.10+** and **ffmpeg** on your PATH.

```bash
cd video && npm install && cd ..
pip install -r requirements.txt
```

On the first run, the free Kokoro voice model (~120 MB) downloads into `models/`.

## Make a video

```bash
python pipeline/make_video.py episodes/rome-never-fell.json                # vertical short
python pipeline/make_video.py episodes/rome-never-fell.json --format both  # short + long
python pipeline/make_video.py episodes/rome-never-fell.json --check        # validate only
```

Preview and tweak live in the browser (hot reload while you edit the JSON):

```bash
cd video && npx remotion studio
```

### Voices

| `--tts` | Cost | Notes |
|---|---|---|
| `kokoro` (default) | Free | Runs locally, Apache-2.0, fine for monetised videos. British voices: `bm_george`, `bm_lewis`, `bm_daniel`, `bf_emma`… |
| `edge` | Free | Microsoft Edge voices (e.g. `en-GB-RyanNeural`) with exact word timings. Unofficial API: check the terms before using it on a monetised channel. |
| `elevenlabs` | Paid | Set `ELEVENLABS_API_KEY`. Best quality, exact word timings. |
| `openai` | Paid | Set `OPENAI_API_KEY`. |
| `none` | Free | Silent, estimated timings. For checking the layout. |

Audio is cached per scene, so editing one scene's narration only re-voices that scene.

## Writing an episode

See `episodes/rome-never-fell.json`. The main pieces:

```jsonc
{
  "title": "What if Rome never fell?",
  "hook": "What if Rome NEVER fell?",          // pinned at the top of vertical videos
  "factions": {                                 // reusable country groups
    "rome": {"color": "#9b2d3a", "countries": ["Italy", "France", "..."]}
  },
  "scenes": [
    {
      "id": "germania",
      "narration": "By 800 AD there is no Charlemagne…",
      "year": "800 AD",                          // date badge
      "title": "Optional big title card",
      "camera": {"center": [11, 49], "zoom": 5.5}, // [lon, lat]; the camera glides between scenes
      "regions": [{"faction": "rome", "countries": ["Germany"], "label": "Roman Empire", "labelAt": [24, 46.8]}],
      "labels": [{"text": "Germania", "coord": [10, 51.5], "kind": "area"}],
      "arrows": [{"from": [8.5, 46.8], "to": [9.5, 53]}]
    }
  ]
}
```

- Country names must match `docs/countries.txt` (modern borders from Natural Earth). `--check` suggests fixes for typos.
- Zoom guide: `1.5`–`2.5` an ocean or continent, `4`–`6` Europe and the Mediterranean, `9`–`12` a region like Italy and the Balkans, `15`–`20` one country.
- A region can extend or trim a faction with `countries` / `remove`, and recolour it with `color`.
- TikTok's Creator Rewards only pays for videos **over 1 minute**, so aim for ~170+ words of narration for shorts.

## Staying monetisable

YouTube demonetises channels whose videos look template-made or repetitive. Vary the camera work, colours, scene count and structure between episodes, and make the scripts genuinely researched and opinionated. The pipeline is a tool for making each video, not a way to mass-produce near-identical ones.

## Layout

```
episodes/   episode scripts (JSON)
pipeline/   Python: validation, TTS, render orchestration
video/      Remotion project (React/TypeScript): map, captions, title cards
docs/       reference (valid country names)
out/        rendered videos (git-ignored)
```

Fonts: Cardo and Montserrat, bundled under the SIL Open Font License. Map data: Natural Earth via `world-atlas` (public domain). Remotion is free for individuals and companies of up to 3 people.
