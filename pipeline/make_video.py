"""Turn an episode script into finished videos.

    python pipeline/make_video.py episodes/rome-never-fell.json
    python pipeline/make_video.py episodes/rome-never-fell.json --format long --tts edge

Steps: check the script → generate a voiceover per scene (cached) → measure
each clip → write render props → render with Remotion into out/.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tts  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
VIDEO = ROOT / "video"
PUBLIC = VIDEO / "public"
BUILD = ROOT / "build"
OUT = ROOT / "out"
COMPOSITIONS = {"short": "Short", "long": "Long"}


def check_script(ep: dict) -> list[str]:
    """Return a list of problems (unknown countries, factions, missing fields)."""
    known = set((ROOT / "docs" / "countries.txt").read_text(encoding="utf-8").split("\n")) | {
        "France (overseas)"
    }
    factions = ep.get("factions", {})
    problems: list[str] = []

    def check_names(names: list[str], where: str) -> None:
        for n in names:
            if n not in known:
                hint = difflib.get_close_matches(n, known, n=1)
                tip = f" (did you mean {hint[0]!r}?)" if hint else ""
                problems.append(f"{where}: unknown country {n!r}{tip}")

    for name, f in factions.items():
        check_names(f.get("countries", []), f"faction {name}")
    ids = set()
    for i, s in enumerate(ep.get("scenes", [])):
        where = f"scene {s.get('id', i)}"
        if s.get("id") in ids:
            problems.append(f"{where}: duplicate id")
        ids.add(s.get("id"))
        for field in ("id", "narration", "camera"):
            if field not in s:
                problems.append(f"{where}: missing {field!r}")
        for r in s.get("regions", []):
            if r.get("faction") and r["faction"] not in factions:
                problems.append(f"{where}: unknown faction {r['faction']!r}")
            check_names(r.get("countries", []) + r.get("remove", []), where)
    return problems


def audio_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def voice_scenes(ep: dict, slug: str, provider: str, voice: str | None) -> dict:
    """Generate (or reuse cached) audio for every scene and fill in timings."""
    if provider == "none":
        return ep
    folder = PUBLIC / "audio" / slug
    folder.mkdir(parents=True, exist_ok=True)
    for s in ep["scenes"]:
        key = hashlib.sha1(f"{provider}|{voice}|{s['narration']}".encode()).hexdigest()[:10]
        base = folder / f"{s['id']}-{key}"
        meta = base.with_suffix(".json")
        if meta.exists():
            info = json.loads(meta.read_text())
            print(f"  ✓ {s['id']} (cached)")
        else:
            print(f"  … {s['id']}")
            speech = tts.say(provider, s["narration"], voice, base)
            info = {
                "file": speech.path.name,
                "duration": audio_duration(speech.path),
                "words": [w.__dict__ for w in speech.words] if speech.words else None,
            }
            meta.write_text(json.dumps(info))
        s["audio"] = f"audio/{slug}/{info['file']}"
        s["durationSec"] = info["duration"]
        if info["words"]:
            s["words"] = info["words"]
    return ep


def render(props_file: Path, fmt: str, slug: str) -> Path:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        sys.exit("npx not found: install Node.js, then run `npm install` in video/")
    OUT.mkdir(exist_ok=True)
    dest = OUT / f"{slug}-{fmt}.mp4"
    cmd = [
        npx, "remotion", "render", "src/index.ts", COMPOSITIONS[fmt], str(dest),
        f"--props={props_file}", "--log=error",
    ]
    print(f"Rendering {fmt} → {dest.relative_to(ROOT)}")
    subprocess.run(cmd, cwd=VIDEO, check=True, env=os.environ.copy())
    return dest


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("episode", type=Path)
    p.add_argument("--format", choices=["short", "long", "both"], default="short")
    p.add_argument("--tts", choices=["kokoro", "edge", "elevenlabs", "openai", "none"], default="kokoro")
    p.add_argument("--voice", help="Voice id for the chosen TTS provider")
    p.add_argument("--check", action="store_true", help="Only validate the script")
    p.add_argument("--no-render", action="store_true", help="Make audio and props, skip rendering")
    args = p.parse_args()

    ep = json.loads(args.episode.read_text(encoding="utf-8"))
    slug = args.episode.stem

    problems = check_script(ep)
    for msg in problems:
        print(f"✗ {msg}")
    if problems:
        sys.exit(1)
    print(f"Script OK: {len(ep['scenes'])} scenes")
    if args.check:
        return

    print(f"Voiceover ({args.tts}):")
    ep = voice_scenes(ep, slug, args.tts, args.voice)
    total = sum(s.get("durationSec", 0) for s in ep["scenes"])
    if total:
        print(f"Narration length: {total:.1f}s")

    BUILD.mkdir(exist_ok=True)
    props = BUILD / f"{slug}.props.json"
    props.write_text(json.dumps(ep, indent=2, ensure_ascii=False), encoding="utf-8")
    if args.no_render:
        print(f"Props written to {props.relative_to(ROOT)}")
        return

    formats = ["short", "long"] if args.format == "both" else [args.format]
    for fmt in formats:
        render(props, fmt, slug)


if __name__ == "__main__":
    main()
