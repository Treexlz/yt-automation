# yt-automation

Script-driven animated map videos for alternate-history Shorts, TikToks and long-form YouTube.

You write (or draft with Claude) an **episode script** in JSON: the narration, plus what the map should do in each scene. The pipeline voices it, times everything to the voiceover and renders:

- `out/<episode>-short.mp4`: 1080×1920 for Shorts, TikTok and Reels
- `out/<episode>-long.mp4`: 1920×1080 for regular YouTube

## Run it with Docker (recommended: NAS or PC)

```bash
git clone https://github.com/Treexlz/yt-automation && cd yt-automation
cp .env.example .env        # optional: password, Claude key, voice keys
docker compose up -d
```

Open `http://<machine-ip>:8080`. Everything you make is stored in `./data`.

`docker compose up -d` pulls the image GitHub Actions builds from this repo (`ghcr.io/treexlz/yt-automation`). The repo is private, so log in once first with a GitHub token that has `read:packages`:

```bash
echo <token> | docker login ghcr.io -u Treexlz --password-stdin
```

Or skip the login and build on the machine: `docker compose up -d --build` (takes a few minutes the first time).

To update: `docker compose pull && docker compose up -d`.

## The web UI

- **Dashboard**: the current render with a live progress bar and log, plus the job queue and history (cancel and retry).
- **Episodes**: create blank episodes, duplicate one, or **draft a whole script with Claude** from a one-line idea.
- **Editor**: the JSON script with live validation (unknown countries, missing fields, under-a-minute warnings), a scene list with estimated timings, and a **Preview** button that renders any scene as an image in about 2 seconds. Choose formats, voice and music, then press Render.
- **Videos**: watch, download and delete renders, with a YouTube thumbnail for each episode and **upload text** (titles, description, tags, TikTok caption, pinned comment).
- **Voices**: try any voice before you use it.
- **Music**: upload background tracks to play quietly under the narration.
- **Settings**: configuration status and a searchable list of country names.

Renders run one at a time in the background, so you can queue several and close the tab.

## Run it without Docker

You need **Node.js 18+**, **Python 3.10+** and **ffmpeg** on your PATH.

```bash
cd video && npm install && cd ..
pip install -r requirements.txt
python pipeline/web.py      # web UI on http://localhost:8080
```

On the first run, the free Kokoro voice model (~120 MB) downloads into `models/`.

### Command line

```bash
python pipeline/make_video.py rome-never-fell                 # vertical short + thumbnail
python pipeline/make_video.py rome-never-fell --format both   # short + long
python pipeline/make_video.py rome-never-fell --check         # validate only
```

Preview and tweak the video code live in the browser:

```bash
cd video && npx remotion studio
```

## Configuration

Set these in `.env` (Docker) or your shell. All are optional.

| Variable | What it does |
|---|---|
| `APP_PASSWORD` | Password for the web UI (any username). Set it before exposing the app beyond your network. |
| `ANTHROPIC_API_KEY` | Script drafting and upload text with Claude (a few pence per draft). |
| `ANTHROPIC_MODEL` | Defaults to `claude-sonnet-5-5`. |
| `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` | Paid voice providers. |
| `RENDER_CONCURRENCY` | Browser tabs per render. 2 suits a NAS; raise it on a fast PC. |
| `YT_DATA_DIR` | Where data lives (`/data` in Docker, the repo folder otherwise). |

## Voices

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
episodes/        sample episode scripts (copied into the data folder on first run)
pipeline/        Python: core pipeline, TTS, job queue, web server, Claude helpers
pipeline/webui/  the web UI (plain HTML/CSS/JS, no build step)
video/           Remotion project (React/TypeScript): map, captions, title cards
video/render.mjs programmatic renderer with progress output
docs/            reference (valid country names)
```

Data folder: `episodes/`, `out/` (videos, thumbnails, upload text), `audio/` (cached voiceovers), `music/`, `models/`, `cache/`, `jobs.db`.

Fonts: Cardo and Montserrat, bundled under the SIL Open Font License. Map data: Natural Earth via `world-atlas` (public domain). Remotion is free for individuals and companies of up to 3 people.
