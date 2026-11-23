"""Render queue: one job at a time in a background thread, history in SQLite."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import traceback
from dataclasses import dataclass, field

import config
import core

MAX_LOG_LINES = 2000


@dataclass
class Live:
    """In-memory state of the running job (fast to poll)."""
    id: int
    log: list[str] = field(default_factory=list)
    progress: float = 0.0
    stage: str = "starting"
    cancel: threading.Event = field(default_factory=threading.Event)


class JobQueue:
    def __init__(self) -> None:
        self.db_path = config.DATA_DIR / "jobs.db"
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.live: Live | None = None
        with self._db() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL,
                    options TEXT NOT NULL,
                    status TEXT NOT NULL,
                    progress REAL DEFAULT 0,
                    stage TEXT DEFAULT '',
                    created REAL, started REAL, finished REAL,
                    error TEXT, outputs TEXT, log TEXT
                )""")
            # Jobs that were running when the server stopped can't resume.
            db.execute(
                "UPDATE jobs SET status='failed', error='Server restarted during render', finished=? "
                "WHERE status='running'", (time.time(),))
        threading.Thread(target=self._worker, daemon=True, name="render-worker").start()

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        return db

    # --- public API ---

    def submit(self, slug: str, formats: list[str], tts: str, voice: str | None, thumbnail: bool) -> int:
        opts = {"formats": formats, "tts": tts, "voice": voice, "thumbnail": thumbnail}
        with self._db() as db:
            cur = db.execute(
                "INSERT INTO jobs (slug, options, status, created) VALUES (?, ?, 'queued', ?)",
                (slug, json.dumps(opts), time.time()))
            job_id = cur.lastrowid
        self.wake.set()
        return job_id

    def cancel(self, job_id: int) -> bool:
        with self.lock:
            if self.live and self.live.id == job_id:
                self.live.cancel.set()
                return True
        with self._db() as db:
            cur = db.execute(
                "UPDATE jobs SET status='cancelled', finished=? WHERE id=? AND status='queued'",
                (time.time(), job_id))
            return cur.rowcount > 0

    def delete(self, job_id: int) -> None:
        with self._db() as db:
            db.execute("DELETE FROM jobs WHERE id=? AND status NOT IN ('running', 'queued')", (job_id,))

    def list(self, limit: int = 50) -> list[dict]:
        with self._db() as db:
            rows = db.execute(
                "SELECT id, slug, options, status, progress, stage, created, started, finished, error, outputs "
                "FROM jobs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [self._row(r) for r in rows]

    def get(self, job_id: int, log_from: int = 0) -> dict | None:
        with self._db() as db:
            r = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not r:
            return None
        job = self._row(r)
        with self.lock:
            live = self.live if self.live and self.live.id == job_id else None
            lines = list(live.log) if live else (r["log"] or "").split("\n") if r["log"] else []
        job["log"] = lines[log_from:]
        job["logTotal"] = len(lines)
        return job

    def queued_count(self) -> int:
        with self._db() as db:
            return db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]

    # --- internals ---

    def _row(self, r: sqlite3.Row) -> dict:
        d = {k: r[k] for k in r.keys() if k != "log"}
        d["options"] = json.loads(d["options"])
        d["outputs"] = json.loads(d["outputs"]) if d.get("outputs") else []
        with self.lock:
            if self.live and self.live.id == d["id"]:
                d["progress"] = self.live.progress
                d["stage"] = self.live.stage
        return d

    def _next(self) -> sqlite3.Row | None:
        with self._db() as db:
            return db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()

    def _worker(self) -> None:
        while True:
            row = self._next()
            if not row:
                self.wake.wait(timeout=5)
                self.wake.clear()
                continue
            self._run(row)

    def _run(self, row: sqlite3.Row) -> None:
        job_id, slug = row["id"], row["slug"]
        opts = json.loads(row["options"])
        live = Live(job_id)
        with self.lock:
            self.live = live
        with self._db() as db:
            db.execute("UPDATE jobs SET status='running', started=? WHERE id=?", (time.time(), job_id))

        def log(msg: str) -> None:
            stamp = time.strftime("%H:%M:%S")
            with self.lock:
                live.log.append(f"[{stamp}] {msg}")
                del live.log[:-MAX_LOG_LINES]

        def progress(p: float, stage: str) -> None:
            live.progress, live.stage = p, stage

        status, error, outputs = "done", None, []
        try:
            log(f"Job {job_id}: {slug} → {', '.join(opts['formats'])} ({opts['tts']})")
            paths = core.produce(
                slug, opts["formats"], opts["tts"], opts.get("voice"),
                thumbnail=opts.get("thumbnail", True), log=log, progress=progress, cancel=live.cancel)
            outputs = [p.name for p in paths]
            log("Finished")
        except core.Cancelled:
            status = "cancelled"
            log("Cancelled")
        except Exception as e:  # noqa: BLE001 - report every failure in the UI
            status, error = "failed", str(e)
            log("FAILED: " + str(e))
            log(traceback.format_exc())

        with self.lock:
            text = "\n".join(live.log)
            self.live = None
        with self._db() as db:
            db.execute(
                "UPDATE jobs SET status=?, progress=?, stage=?, finished=?, error=?, outputs=?, log=? WHERE id=?",
                (status, live.progress if status != "done" else 1.0, live.stage, time.time(), error,
                 json.dumps(outputs), text, job_id))
