"""Web UI and API.

    python pipeline/web.py            # http://localhost:8080
    PORT=9000 python pipeline/web.py

Set APP_PASSWORD to require a password (any username) when exposing it
beyond your own machine.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import shutil
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn  # noqa: E402
from fastapi import FastAPI, File, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import ai  # noqa: E402
import config  # noqa: E402
import core  # noqa: E402
import tts  # noqa: E402
from jobs import JobQueue  # noqa: E402

VERSION = "0.2.0"
UI_DIR = Path(__file__).resolve().parent / "webui"
PASSWORD = os.environ.get("APP_PASSWORD", "")

config.ensure_dirs()
(config.CACHE / "voice-tests").mkdir(parents=True, exist_ok=True)
queue = JobQueue()
preview_lock = threading.Lock()


def _prefetch_voice_model() -> None:
    """Download the free Kokoro model in the background on first start."""
    try:
        tts.download_kokoro()
    except Exception as e:  # noqa: BLE001
        print(f"Couldn't download the Kokoro voice model yet: {e}")


threading.Thread(target=_prefetch_voice_model, daemon=True).start()
app = FastAPI(title="yt-automation", version=VERSION)


# --- optional password ---------------------------------------------------------

@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if PASSWORD and request.url.path != "/healthz":
        header = request.headers.get("authorization", "")
        ok = False
        if header.lower().startswith("basic "):
            try:
                _, _, pw = base64.b64decode(header[6:]).decode().partition(":")
                ok = secrets.compare_digest(pw, PASSWORD)
            except Exception:  # noqa: BLE001
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="yt-automation"'})
    return await call_next(request)


@app.get("/healthz")
def healthz():
    return {"ok": True}


# --- status --------------------------------------------------------------------

@app.get("/api/status")
def status():
    disk = shutil.disk_usage(config.DATA_DIR)
    return {
        "version": VERSION,
        "dataDir": str(config.DATA_DIR),
        "claude": ai.available(),
        "claudeModel": ai.MODEL if ai.available() else None,
        "queue": queue.queued_count(),
        "diskFreeGb": round(disk.free / 1e9, 1),
        "diskTotalGb": round(disk.total / 1e9, 1),
        "renderConcurrency": config.RENDER_CONCURRENCY,
        "passwordProtected": bool(PASSWORD),
    }


# --- episodes ------------------------------------------------------------------

class NewEpisode(BaseModel):
    title: str
    slug: str | None = None
    duplicateOf: str | None = None
    episode: dict | None = None


class EpisodeBody(BaseModel):
    episode: dict


def _get_episode(slug: str) -> dict:
    try:
        return core.load_episode(slug)
    except FileNotFoundError:
        raise HTTPException(404, f"No episode {slug!r}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    except json.JSONDecodeError as e:
        raise HTTPException(422, f"Episode file is not valid JSON: {e}")


@app.get("/api/episodes")
def episodes():
    return core.list_episodes()


@app.post("/api/episodes")
def create_episode(body: NewEpisode):
    slug = core.slugify(body.slug or body.title)
    base, n = slug, 2
    while core.episode_path(slug).exists():
        slug, n = f"{base}-{n}", n + 1
    if body.episode:
        ep = body.episode
    elif body.duplicateOf:
        ep = _get_episode(body.duplicateOf)
    else:
        ep = {
            "title": body.title,
            "hook": body.title,
            "factions": {},
            "scenes": [{
                "id": "intro",
                "narration": "Write the opening line here.",
                "title": body.title,
                "camera": {"center": [10, 45], "zoom": 3},
            }],
        }
    ep["title"] = body.title or ep.get("title", slug)
    core.save_episode(slug, ep)
    return {"slug": slug}


@app.get("/api/episodes/{slug}")
def get_episode(slug: str):
    ep = _get_episode(slug)
    return {"slug": slug, "episode": ep, "problems": core.check_script(ep), "warnings": core.warnings(ep)}


@app.put("/api/episodes/{slug}")
def put_episode(slug: str, body: EpisodeBody):
    core.save_episode(slug, body.episode)
    return {"ok": True, "problems": core.check_script(body.episode), "warnings": core.warnings(body.episode)}


@app.delete("/api/episodes/{slug}")
def delete_episode(slug: str):
    core.delete_episode(slug)
    return {"ok": True}


@app.post("/api/validate")
def validate(body: EpisodeBody):
    ep = body.episode
    problems = core.check_script(ep)
    timeline = []
    if not any("needs at least one scene" in p for p in problems):
        try:
            timeline = [
                {"id": sid, "start": round(f / config.FPS, 1), "seconds": round(n / config.FPS, 1)}
                for sid, f, n in core.scene_starts(ep)
            ]
        except (KeyError, TypeError):
            pass
    return {"problems": problems, "warnings": core.warnings(ep), "timeline": timeline}


class PreviewBody(BaseModel):
    episode: dict
    sceneId: str
    format: str = "short"


@app.post("/api/preview")
def preview(body: PreviewBody):
    problems = core.check_script(body.episode)
    if problems:
        raise HTTPException(422, "Fix the script first:\n" + "\n".join(problems))
    with preview_lock:  # one browser at a time keeps small machines responsive
        try:
            path = core.preview_scene(body.episode, body.sceneId, body.format, log=lambda m: None)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(500, f"Preview failed: {e}")
    return {"url": f"/media/previews/{path.name}"}


class DraftBody(BaseModel):
    idea: str
    length: str = "short"
    notes: str = ""


@app.post("/api/draft")
def draft(body: DraftBody):
    if not ai.available():
        raise HTTPException(400, "Set ANTHROPIC_API_KEY to draft scripts with Claude")
    try:
        ep = ai.draft_episode(body.idea, body.length, body.notes)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Drafting failed: {e}")
    return {"episode": ep, "problems": core.check_script(ep), "warnings": core.warnings(ep)}


@app.post("/api/episodes/{slug}/metadata")
def metadata(slug: str):
    ep = _get_episode(slug)
    try:
        data = ai.write_metadata(ep)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Metadata failed: {e}")
    (config.OUT / f"{slug}-metadata.json").write_text(json.dumps(data, indent=2, ensure_ascii=False))
    return data


@app.get("/api/episodes/{slug}/metadata")
def get_metadata(slug: str):
    f = config.OUT / f"{slug}-metadata.json"
    if not f.exists():
        raise HTTPException(404, "No metadata yet")
    return json.loads(f.read_text())


# --- jobs ----------------------------------------------------------------------

class JobBody(BaseModel):
    slug: str
    formats: list[str] = ["short"]
    tts: str = "kokoro"
    voice: str | None = None
    thumbnail: bool = True


@app.post("/api/jobs")
def submit_job(body: JobBody):
    ep = _get_episode(body.slug)
    problems = core.check_script(ep)
    if problems:
        raise HTTPException(422, "Fix the script first:\n" + "\n".join(problems))
    if not body.formats or any(f not in config.COMPOSITIONS for f in body.formats):
        raise HTTPException(400, "formats must be 'short' and/or 'long'")
    if body.tts not in (*tts.PROVIDERS, "none"):
        raise HTTPException(400, f"Unknown TTS provider {body.tts!r}")
    ok, why = tts.available(body.tts) if body.tts != "none" else (True, "")
    if not ok:
        raise HTTPException(400, why)
    job_id = queue.submit(body.slug, body.formats, body.tts, body.voice or None, body.thumbnail)
    return {"id": job_id}


@app.get("/api/jobs")
def list_jobs():
    return queue.list()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: int, logFrom: int = 0):
    job = queue.get(job_id, logFrom)
    if not job:
        raise HTTPException(404, "No such job")
    return job


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: int):
    return {"ok": queue.cancel(job_id)}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: int):
    queue.delete(job_id)
    return {"ok": True}


# --- videos --------------------------------------------------------------------

@app.get("/api/videos")
def videos():
    groups: dict[str, dict] = {}
    for f in sorted(config.OUT.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if f.suffix not in (".mp4", ".jpg", ".json"):
            continue
        slug, _, kind = f.stem.rpartition("-")
        if kind not in ("short", "long", "thumbnail", "metadata"):
            continue
        g = groups.setdefault(slug, {"slug": slug, "files": {}, "modified": f.stat().st_mtime})
        g["files"][kind] = {
            "name": f.name, "url": f"/media/out/{f.name}",
            "sizeMb": round(f.stat().st_size / 1e6, 1), "modified": f.stat().st_mtime,
        }
    return list(groups.values())


@app.delete("/api/videos/{name}")
def delete_video(name: str):
    f = (config.OUT / name).resolve()
    if f.parent != config.OUT.resolve() or not f.exists():
        raise HTTPException(404, "No such file")
    f.unlink()
    return {"ok": True}


# --- voices --------------------------------------------------------------------

@app.get("/api/voices")
def voices():
    out = []
    for p in ("kokoro", "edge", "elevenlabs", "openai"):
        ok, why = tts.available(p)
        out.append({
            "provider": p, "available": ok, "reason": why,
            "default": tts.DEFAULT_VOICES[p], "voices": tts.list_voices(p),
        })
    return out


class VoiceTest(BaseModel):
    provider: str = "kokoro"
    voice: str | None = None
    text: str = "In 476 AD, the last emperor of the Western Roman Empire was overthrown."


@app.post("/api/voices/test")
def voice_test(body: VoiceTest):
    if body.provider not in tts.PROVIDERS:
        raise HTTPException(400, "Unknown provider")
    ok, why = tts.available(body.provider)
    if not ok:
        raise HTTPException(400, why)
    key = hashlib.sha1(f"{body.provider}|{body.voice}|{body.text}".encode()).hexdigest()[:12]
    folder = config.CACHE / "voice-tests"
    existing = list(folder.glob(f"{key}.*"))
    if existing:
        return {"url": f"/media/voice-tests/{existing[0].name}"}
    try:
        speech = tts.say(body.provider, body.text[:500], body.voice, folder / key)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Voice generation failed: {e}")
    return {"url": f"/media/voice-tests/{speech.path.name}"}


# --- music ---------------------------------------------------------------------

@app.get("/api/music")
def music():
    return [
        {"name": f.name, "path": f"music/{f.name}", "url": f"/media/music/{f.name}",
         "sizeMb": round(f.stat().st_size / 1e6, 1)}
        for f in sorted(config.MUSIC.iterdir()) if f.suffix.lower() in (".mp3", ".wav", ".m4a", ".ogg")
    ]


@app.post("/api/music")
async def upload_music(file: UploadFile = File(...)):
    name = Path(file.filename or "track.mp3").name
    stem, suffix = Path(name).stem, Path(name).suffix.lower()
    if suffix not in (".mp3", ".wav", ".m4a", ".ogg"):
        raise HTTPException(400, "Upload an mp3, wav, m4a or ogg file")
    dest = config.MUSIC / f"{core.slugify(stem)}{suffix}"
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    return {"name": dest.name, "path": f"music/{dest.name}"}


@app.delete("/api/music/{name}")
def delete_music(name: str):
    f = (config.MUSIC / name).resolve()
    if f.parent != config.MUSIC.resolve():
        raise HTTPException(400, "Bad name")
    f.unlink(missing_ok=True)
    return {"ok": True}


@app.get("/api/countries")
def countries():
    return sorted(core.known_countries())


# --- files and UI ----------------------------------------------------------------

app.mount("/media/out", StaticFiles(directory=config.OUT), name="out")
app.mount("/media/previews", StaticFiles(directory=config.PREVIEWS), name="previews")
app.mount("/media/voice-tests", StaticFiles(directory=config.CACHE / "voice-tests"), name="voicetests")
app.mount("/media/music", StaticFiles(directory=config.MUSIC), name="music")
app.mount("/static", StaticFiles(directory=UI_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(UI_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.exception_handler(ValueError)
def value_error(_: Request, exc: ValueError):
    return JSONResponse({"detail": str(exc)}, status_code=400)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"yt-automation web UI on http://localhost:{port}  (data: {config.DATA_DIR})")
    uvicorn.run(app, host=host, port=port, log_level="warning")
