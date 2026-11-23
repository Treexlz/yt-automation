"""Where things live.

Everything you create (episodes, voiceovers, videos, music, models) goes in
DATA_DIR. Locally that's the repo folder; in Docker it's the /data volume.
"""

from __future__ import annotations

import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
VIDEO_DIR = APP_DIR / "video"
DATA_DIR = Path(os.environ.get("YT_DATA_DIR", APP_DIR)).resolve()

EPISODES = DATA_DIR / "episodes"
OUT = DATA_DIR / "out"
BUILD = DATA_DIR / "build"
AUDIO = DATA_DIR / "audio"
MUSIC = DATA_DIR / "music"
MODELS = DATA_DIR / "models"
CACHE = DATA_DIR / "cache"
PREVIEWS = CACHE / "previews"

COUNTRIES_FILE = APP_DIR / "docs" / "countries.txt"
SAMPLE_EPISODES = APP_DIR / "episodes"

FPS = 30
COMPOSITIONS = {"short": "Short", "long": "Long"}

# Parallel browser tabs per render. Lower it on small machines (NAS).
RENDER_CONCURRENCY = int(os.environ.get("RENDER_CONCURRENCY", "0")) or None


def ensure_dirs() -> None:
    for d in (EPISODES, OUT, BUILD, AUDIO, MUSIC, MODELS, CACHE, PREVIEWS):
        d.mkdir(parents=True, exist_ok=True)
    # First run with an empty data folder: copy in the sample episodes.
    if not any(EPISODES.glob("*.json")) and SAMPLE_EPISODES.resolve() != EPISODES.resolve():
        for f in SAMPLE_EPISODES.glob("*.json"):
            (EPISODES / f.name).write_bytes(f.read_bytes())
