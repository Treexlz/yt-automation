"""Turn an episode script into finished videos (command-line version).

    python pipeline/make_video.py rome-never-fell
    python pipeline/make_video.py episodes/rome-never-fell.json --format both --tts edge
    python pipeline/make_video.py rome-never-fell --check

The same pipeline runs behind the web UI (python pipeline/web.py).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config  # noqa: E402
import core  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("episode", help="Episode name or path to its JSON file")
    p.add_argument("--format", choices=["short", "long", "both"], default="short")
    p.add_argument("--tts", choices=["kokoro", "edge", "elevenlabs", "openai", "none"], default="kokoro")
    p.add_argument("--voice", help="Voice id for the chosen TTS provider")
    p.add_argument("--check", action="store_true", help="Only validate the script")
    p.add_argument("--no-thumbnail", action="store_true")
    args = p.parse_args()

    config.ensure_dirs()
    path = Path(args.episode)
    if path.suffix == ".json":
        if path.resolve().parent != config.EPISODES.resolve():
            # A script from elsewhere: copy it into the episodes folder.
            (config.EPISODES / path.name).write_bytes(path.read_bytes())
        slug = path.stem
    else:
        slug = args.episode

    ep = core.load_episode(slug)
    problems = core.check_script(ep)
    for msg in problems:
        print(f"✗ {msg}")
    if problems:
        sys.exit(1)
    for w in core.warnings(ep):
        print(f"! {w}")
    print(f"Script OK: {len(ep['scenes'])} scenes")
    if args.check:
        return

    formats = ["short", "long"] if args.format == "both" else [args.format]
    last = [-1]

    def progress(p: float, stage: str) -> None:
        pct = int(p * 100)
        if pct != last[0] and pct % 5 == 0:
            last[0] = pct
            print(f"  {pct:3d}% {stage}")

    outputs = core.produce(
        slug, formats, args.tts, args.voice,
        thumbnail=not args.no_thumbnail, progress=progress,
    )
    print("Done:")
    for o in outputs:
        print(f"  {o}")


if __name__ == "__main__":
    main()
