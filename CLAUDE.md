# yt-automation: notes for Claude

Alternate-history map videos. An episode JSON (`episodes/*.json`) is voiced by `pipeline/make_video.py` and rendered by the Remotion project in `video/`.

- Episode schema: `video/src/types.ts`. Keep `README.md` in sync when it changes.
- Country names must match `docs/countries.txt`. Run `python pipeline/make_video.py <episode> --check` after editing a script.
- Type-check: `cd video && npx tsc -p .`. Preview single frames: `npx remotion still src/index.ts Short /tmp/f.png --frame=300`.
- Default TTS is local Kokoro (free, commercial-safe). Don't add paid services as defaults; the tool budget is under £30/month.
- When drafting scripts: keep real history accurate, clearly frame the alternate parts as speculation, avoid controversial or tragedy-exploiting topics, and vary structure between episodes (YouTube demonetises template-like channels).
