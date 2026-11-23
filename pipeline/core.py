"""The pipeline as a library, shared by the command line and the web app."""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import threading
from pathlib import Path
from typing import Callable

import config
import tts

LogFn = Callable[[str], None]
ProgressFn = Callable[[float, str], None]


class Cancelled(Exception):
    pass


# --- episodes ----------------------------------------------------------------

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (s or "episode")[:60]


def episode_path(slug: str) -> Path:
    if not SLUG_RE.match(slug):
        raise ValueError(f"Bad episode name {slug!r}")
    return config.EPISODES / f"{slug}.json"


def list_episodes() -> list[dict]:
    items = []
    for f in sorted(config.EPISODES.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            ep = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            ep = {"title": f"{f.stem} (invalid JSON)", "scenes": []}
        scenes = ep.get("scenes", [])
        items.append({
            "slug": f.stem,
            "title": ep.get("title", f.stem),
            "scenes": len(scenes),
            "words": sum(len(s.get("narration", "").split()) for s in scenes),
            "estimatedSeconds": round(sum(estimate_seconds(s.get("narration", "")) + 0.5 for s in scenes), 1),
            "modified": f.stat().st_mtime,
        })
    return items


def load_episode(slug: str) -> dict:
    return json.loads(episode_path(slug).read_text(encoding="utf-8"))


def pretty_json(obj) -> str:
    """Indented JSON with short arrays (countries, coordinates) on one line."""
    text = json.dumps(obj, indent=2, ensure_ascii=False)
    return re.sub(r"\[\s*([^\[\]{}]*?)\s*\]", lambda m: "[" + re.sub(r"\s*\n\s*", " ", m.group(1)) + "]", text)


def save_episode(slug: str, ep: dict) -> None:
    episode_path(slug).write_text(pretty_json(ep) + "\n", encoding="utf-8")


def delete_episode(slug: str) -> None:
    episode_path(slug).unlink(missing_ok=True)


# --- validation --------------------------------------------------------------

def known_countries() -> set[str]:
    names = set(config.COUNTRIES_FILE.read_text(encoding="utf-8").split("\n"))
    return {n for n in names if n} | {"France (overseas)"}


def check_script(ep: dict) -> list[str]:
    """Problems that would break or spoil a render (empty list = OK)."""
    known = known_countries()
    factions = ep.get("factions", {}) or {}
    problems: list[str] = []

    if not isinstance(ep.get("scenes"), list) or not ep["scenes"]:
        return ["The episode needs at least one scene"]

    def check_names(names: list[str], where: str) -> None:
        for n in names:
            if n not in known:
                hint = difflib.get_close_matches(n, known, n=1)
                tip = f" (did you mean {hint[0]!r}?)" if hint else ""
                problems.append(f"{where}: unknown country {n!r}{tip}")

    for name, f in factions.items():
        if "color" not in f:
            problems.append(f"faction {name}: missing 'color'")
        check_names(f.get("countries", []), f"faction {name}")

    ids = set()
    for i, s in enumerate(ep["scenes"]):
        where = f"scene {s.get('id', i + 1)}"
        if s.get("id") in ids:
            problems.append(f"{where}: duplicate id")
        ids.add(s.get("id"))
        for field in ("id", "narration", "camera"):
            if field not in s:
                problems.append(f"{where}: missing {field!r}")
        cam = s.get("camera", {})
        if cam and (len(cam.get("center", [])) != 2 or not cam.get("zoom")):
            problems.append(f"{where}: camera needs center [lon, lat] and zoom")
        if s.get("id") and not SLUG_RE.match(str(s["id"])):
            problems.append(f"{where}: id should be lowercase letters, numbers and dashes")
        for r in s.get("regions", []):
            if r.get("faction") and r["faction"] not in factions:
                problems.append(f"{where}: unknown faction {r['faction']!r}")
            check_names(r.get("countries", []) + r.get("remove", []), where)
    if ep.get("music") and not (config.MUSIC / Path(ep["music"]).name).exists():
        problems.append(f"music file {ep['music']!r} not found in the music library")
    return problems


def warnings(ep: dict) -> list[str]:
    """Things that won't break a render but are worth knowing."""
    out = []
    total = sum(estimate_seconds(s.get("narration", "")) + 0.5 for s in ep.get("scenes", []))
    if total < 61:
        out.append(f"About {total:.0f}s long: TikTok Creator Rewards only pays for videos over 1 minute")
    for s in ep.get("scenes", []):
        if len(s.get("narration", "").split()) > 70:
            out.append(f"scene {s.get('id')}: long narration, consider splitting it so the map changes more often")
    return out


# --- timing (mirrors video/src/timing.ts) -------------------------------------

def estimate_seconds(text: str) -> float:
    return len(text.split()) / 2.6 + 0.4


def scene_starts(ep: dict) -> list[tuple[str, int, int]]:
    """(scene id, first frame, frame count) for each scene."""
    out, frm = [], 0
    for s in ep["scenes"]:
        sec = (s.get("durationSec") or estimate_seconds(s.get("narration", ""))) + 0.5
        n = max(1, round(sec * config.FPS))
        out.append((s["id"], frm, n))
        frm += n
    return out


# --- voiceover ---------------------------------------------------------------

def audio_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def voice_scenes(
    ep: dict, slug: str, provider: str, voice: str | None,
    log: LogFn = print, progress: ProgressFn | None = None,
    cancel: threading.Event | None = None,
) -> dict:
    """Generate (or reuse cached) audio for every scene and fill in timings."""
    ep = json.loads(json.dumps(ep))  # don't modify the caller's copy
    if provider == "none":
        return ep
    folder = config.AUDIO / slug
    folder.mkdir(parents=True, exist_ok=True)
    n = len(ep["scenes"])
    for i, s in enumerate(ep["scenes"]):
        if cancel and cancel.is_set():
            raise Cancelled()
        key = hashlib.sha1(f"{provider}|{voice}|{s['narration']}".encode()).hexdigest()[:10]
        base = folder / f"{s['id']}-{key}"
        meta = base.with_suffix(".json")
        if meta.exists():
            info = json.loads(meta.read_text())
            log(f"Voice: {s['id']} (cached)")
        else:
            log(f"Voice: {s['id']}…")
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
        if progress:
            progress((i + 1) / n, "voice")
    return ep


def write_props(ep: dict, slug: str) -> Path:
    config.BUILD.mkdir(parents=True, exist_ok=True)
    props = config.BUILD / f"{slug}.props.json"
    props.write_text(json.dumps(ep, indent=2, ensure_ascii=False), encoding="utf-8")
    return props


# --- rendering ---------------------------------------------------------------

def _node() -> str:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js not found. Install it, then run `npm install` in video/")
    return node


# Harmless messages Remotion prints inside containers.
_NOISE = ("Detected differing memory amounts", "Memory reported by", "--memory flag", "Using the lower amount")


def run_renderer(
    job: dict, log: LogFn = print, progress: ProgressFn | None = None,
    cancel: threading.Event | None = None,
) -> dict:
    """Run video/render.mjs and relay its progress. Returns the 'done' message."""
    job = {
        "audioDir": str(config.AUDIO),
        "musicDir": str(config.MUSIC),
        "cacheDir": str(config.CACHE / "bundle"),
        **job,
    }
    proc = subprocess.Popen(
        [_node(), "render.mjs", json.dumps(job)],
        cwd=config.VIDEO_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, start_new_session=True,
    )
    stopper = None
    if cancel:
        def watch():
            cancel.wait()
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
        stopper = threading.Thread(target=watch, daemon=True)
        stopper.start()

    done, error = None, None
    assert proc.stdout
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            if not any(n in line for n in _NOISE):
                log(line)  # stray output from Chrome/webpack
            continue
        kind = msg.get("type")
        if kind == "progress" and progress:
            progress(msg["progress"], "render")
        elif kind == "log":
            log(msg["message"])
        elif kind == "done":
            done = msg
        elif kind == "error":
            error = msg["message"]
    proc.wait()
    if cancel and cancel.is_set():
        raise Cancelled()
    if proc.returncode != 0 or not done:
        raise RuntimeError(error or f"Renderer exited with code {proc.returncode}")
    return done


def render_video(props: Path, fmt: str, dest: Path, scale: float = 1, **kw) -> Path:
    run_renderer({
        "mode": "video",
        "composition": config.COMPOSITIONS[fmt],
        "props": str(props),
        "output": str(dest),
        "scale": scale,
        "concurrency": config.RENDER_CONCURRENCY,
    }, **kw)
    return dest


def render_still(props: Path, fmt: str, frame: int, dest: Path, scale: float = 1, **kw) -> Path:
    run_renderer({
        "mode": "still",
        "composition": config.COMPOSITIONS[fmt],
        "props": str(props),
        "output": str(dest),
        "frame": frame,
        "scale": scale,
    }, **kw)
    return dest


def preview_scene(ep: dict, scene_id: str, fmt: str = "short", **kw) -> Path:
    """Quick low-res still of a scene, after the camera has settled.
    Uses estimated timings, so it needs no voiceover."""
    starts = {sid: (f, n) for sid, f, n in scene_starts(ep)}
    if scene_id not in starts:
        raise ValueError(f"No scene {scene_id!r}")
    first, n = starts[scene_id]
    frame = first + min(n - 1, max(45, int(n * 0.6)))
    key = hashlib.sha1(json.dumps([ep, scene_id, fmt], sort_keys=True).encode()).hexdigest()[:16]
    dest = config.PREVIEWS / f"{key}.jpg"
    if dest.exists():
        return dest
    props = config.PREVIEWS / f"{key}.props.json"
    props.write_text(json.dumps(ep, ensure_ascii=False), encoding="utf-8")
    try:
        render_still(props, fmt, frame, dest, scale=0.5, **kw)
    finally:
        props.unlink(missing_ok=True)
    return dest


def make_thumbnail(props: Path, dest: Path, **kw) -> Path:
    """YouTube thumbnail (1280×720) from the first scene of the long format."""
    ep = json.loads(props.read_text(encoding="utf-8"))
    _, first, n = scene_starts(ep)[0]
    return render_still(props, "long", first + min(n - 1, 40), dest, scale=2 / 3, **kw)


def produce(
    slug: str, formats: list[str], provider: str, voice: str | None,
    thumbnail: bool = True, log: LogFn = print, progress: ProgressFn | None = None,
    cancel: threading.Event | None = None,
) -> list[Path]:
    """The whole job: check → voice → render each format → thumbnail."""
    ep = load_episode(slug)
    problems = check_script(ep)
    if problems:
        raise ValueError("Script has problems:\n" + "\n".join(problems))
    for w in warnings(ep):
        log(f"Note: {w}")

    # Split the progress bar: 15% voice, the rest shared between renders.
    steps = len(formats) + (1 if thumbnail else 0)
    def sub(start: float, width: float) -> ProgressFn | None:
        if not progress:
            return None
        return lambda p, stage: progress(start + p * width, stage)

    ep = voice_scenes(ep, slug, provider, voice, log=log, progress=sub(0, 0.15), cancel=cancel)
    total = sum(s.get("durationSec") or estimate_seconds(s["narration"]) for s in ep["scenes"])
    log(f"Narration: {total:.1f}s")
    props = write_props(ep, slug)

    outputs: list[Path] = []
    share = 0.85 / steps
    for i, fmt in enumerate(formats):
        dest = config.OUT / f"{slug}-{fmt}.mp4"
        log(f"Rendering {fmt} ({'9:16' if fmt == 'short' else '16:9'})…")
        render_video(props, fmt, dest, log=log, progress=sub(0.15 + i * share, share), cancel=cancel)
        outputs.append(dest)
        log(f"Saved {dest.name}")
    if thumbnail:
        dest = config.OUT / f"{slug}-thumbnail.jpg"
        log("Rendering thumbnail…")
        make_thumbnail(props, dest, log=log, cancel=cancel)
        outputs.append(dest)
    if progress:
        progress(1.0, "done")
    return outputs
