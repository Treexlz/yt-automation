"""Text-to-speech providers.

Each provider turns one scene's narration into an audio file and, where the
engine supports it, word timings for karaoke-style captions.

    kokoro      Free, runs locally, Apache-2.0 licence (safe for monetised use).
    edge        Free Microsoft Edge voices with word timings. Unofficial API:
                fine for testing, check the terms before relying on it commercially.
    elevenlabs  Best quality, paid. Needs ELEVENLABS_API_KEY.
    openai      Good quality, paid. Needs OPENAI_API_KEY.
    none        No audio; timings are estimated from the text. For layout checks.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"

KOKORO_FILES = {
    "kokoro-v1.0.int8.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx",
    "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}

DEFAULT_VOICES = {
    "kokoro": "bm_george",
    "edge": "en-GB-RyanNeural",
    "elevenlabs": "JBFqnCBsd6RMkjVDRZzb",  # "George"
    "openai": "onyx",
}


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Speech:
    path: Path
    words: list[Word] | None  # None = engine gave no timings


def download_kokoro() -> None:
    MODELS.mkdir(exist_ok=True)
    for name, url in KOKORO_FILES.items():
        dest = MODELS / name
        if dest.exists() and dest.stat().st_size > 0:
            continue
        print(f"Downloading {name} …")
        urllib.request.urlretrieve(url, dest)


# --- providers ---------------------------------------------------------------

_kokoro = None


def _say_kokoro(text: str, voice: str, out: Path) -> Speech:
    global _kokoro
    import soundfile as sf
    from kokoro_onnx import Kokoro

    if _kokoro is None:
        download_kokoro()
        _kokoro = Kokoro(str(MODELS / "kokoro-v1.0.int8.onnx"), str(MODELS / "voices-v1.0.bin"))
    lang = "en-gb" if voice.startswith("b") else "en-us"
    samples, rate = _kokoro.create(text, voice=voice, speed=1.0, lang=lang)
    out = out.with_suffix(".wav")
    sf.write(out, samples, rate)
    return Speech(out, None)


def _say_edge(text: str, voice: str, out: Path) -> Speech:
    import edge_tts

    out = out.with_suffix(".mp3")

    async def run() -> list[Word]:
        words: list[Word] = []
        comm = edge_tts.Communicate(text, voice, boundary="WordBoundary")
        with open(out, "wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start = chunk["offset"] / 1e7  # 100-nanosecond units
                    words.append(Word(chunk["text"], start, start + chunk["duration"] / 1e7))
        return words

    return Speech(out, _attach_punctuation(text, asyncio.run(run())))


def _say_elevenlabs(text: str, voice: str, out: Path) -> Speech:
    key = os.environ["ELEVENLABS_API_KEY"]
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice}/with-timestamps",
        data=json.dumps({"text": text, "model_id": "eleven_multilingual_v2"}).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        body = json.load(r)
    out = out.with_suffix(".mp3")
    out.write_bytes(base64.b64decode(body["audio_base64"]))

    # Group character timings into words.
    a = body.get("alignment") or {}
    words: list[Word] = []
    cur, start, end = "", None, 0.0
    for ch, s, e in zip(
        a.get("characters", []),
        a.get("character_start_times_seconds", []),
        a.get("character_end_times_seconds", []),
    ):
        if ch.isspace():
            if cur:
                words.append(Word(cur, start, end))
            cur, start = "", None
        else:
            cur += ch
            start = s if start is None else start
            end = e
    if cur:
        words.append(Word(cur, start, end))
    return Speech(out, words or None)


def _say_openai(text: str, voice: str, out: Path) -> Speech:
    key = os.environ["OPENAI_API_KEY"]
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=json.dumps(
            {"model": "gpt-4o-mini-tts", "voice": voice, "input": text, "response_format": "mp3"}
        ).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    out = out.with_suffix(".mp3")
    with urllib.request.urlopen(req) as r:
        out.write_bytes(r.read())
    return Speech(out, None)


def _attach_punctuation(text: str, words: list[Word]) -> list[Word]:
    """Edge reports bare words; put the script's punctuation back for captions."""
    tokens = text.split()
    if len(tokens) != len(words):
        return words
    return [Word(t, w.start, w.end) for t, w in zip(tokens, words)]


PROVIDERS = {
    "kokoro": _say_kokoro,
    "edge": _say_edge,
    "elevenlabs": _say_elevenlabs,
    "openai": _say_openai,
}


def say(provider: str, text: str, voice: str | None, out: Path) -> Speech:
    return PROVIDERS[provider](text, voice or DEFAULT_VOICES[provider], out)
