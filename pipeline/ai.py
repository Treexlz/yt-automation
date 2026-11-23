"""Optional Claude helpers: draft an episode from an idea, write upload metadata.

Needs ANTHROPIC_API_KEY. A drafted episode costs a few pence with Sonnet.
Everything else in the app works without it.
"""

from __future__ import annotations

import json
import os
import re

import config
import core

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5")


def available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _client():
    import anthropic
    return anthropic.Anthropic()


def _ask(system: str, prompt: str, max_tokens: int = 8000) -> str:
    msg = _client().messages.create(
        model=MODEL,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")


def _extract_json(text: str) -> dict:
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    raw = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(raw)


GUIDELINES = """\
- Real history must be accurate. Make it obvious which parts are speculation ("might", "could", "in this timeline").
- No controversial or politically divisive topics, and don't exploit tragedies, wars or atrocities for drama.
- Hook in the first sentence. Short, punchy sentences that read well aloud. British English spelling.
- Each scene should change something on the map: camera move, new region, arrow or label.
- Vary structure, pacing and visuals. Don't fall into the same template every time.
- End with a question that invites comments.
"""


def draft_episode(idea: str, length: str = "short", notes: str = "") -> dict:
    """Ask Claude for a complete episode JSON. Validates and repairs once."""
    schema = (config.VIDEO_DIR / "src" / "types.ts").read_text(encoding="utf-8")
    sample = (config.APP_DIR / "episodes" / "rome-never-fell.json").read_text(encoding="utf-8")
    countries = ", ".join(sorted(core.known_countries()))
    target = (
        "about 170–200 words of narration across 6–9 scenes (a 65–80 second vertical short)"
        if length == "short" else
        "about 1,200–1,600 words of narration across 20–35 scenes (an 8–10 minute video)"
    )
    system = (
        "You write scripts for an alternate-history YouTube and TikTok channel that renders "
        "animated maps from a JSON episode format. Reply with only the JSON, in a ```json block."
    )
    prompt = f"""Write an episode for this idea: {idea}

Length: {target}.
{f"Extra notes from the creator: {notes}" if notes else ""}

Guidelines:
{GUIDELINES}
The JSON must match this TypeScript schema (omit the fields the pipeline fills in: audio, durationSec, words):
```ts
{schema}
```

Country names must be exactly from this list (modern borders): {countries}

Camera zoom guide: 1.5–2.5 ocean or continent, 4–6 Europe/Mediterranean, 9–12 a region, 15–20 one country.
Use "factions" for groups of countries that recur across scenes. Use labelAt for faction labels.
Scene ids are lowercase-with-dashes.

Here is an example episode for format reference (don't copy its structure):
```json
{sample}
```"""
    ep = _extract_json(_ask(system, prompt))
    problems = core.check_script(ep)
    if problems:
        fix = _ask(system, prompt + "\n\nYour previous attempt:\n```json\n" + json.dumps(ep) +
                   "\n```\nFix these problems and reply with the corrected JSON:\n" + "\n".join(problems))
        ep = _extract_json(fix)
    return ep


def write_metadata(ep: dict) -> dict:
    """Titles, description, tags and captions for uploading."""
    narration = "\n".join(s.get("narration", "") for s in ep.get("scenes", []))
    if not available():
        # Basic version without AI.
        first = ep.get("scenes", [{}])[0].get("narration", "")
        return {
            "youtubeTitle": ep.get("title", ""),
            "youtubeDescription": f"{first}\n\nAn alternate history: what might have happened? "
                                  "Tell me in the comments.\n\n#alternatehistory #history #whatif",
            "tags": ["alternate history", "history", "what if", "map animation"],
            "tiktokCaption": f"{ep.get('title', '')} #alternatehistory #history #whatif #maps",
            "generatedBy": "template",
        }
    system = "You write upload metadata for an alternate-history map channel. Reply with only JSON."
    prompt = f"""Episode title: {ep.get('title')}
Narration:
{narration}

Return JSON with:
- "youtubeTitles": 3 options, under 70 characters, curiosity-driven but not misleading
- "youtubeDescription": 2 short paragraphs, mention it's speculative alternate history, end with 3–5 hashtags
- "tags": 10–15 YouTube tags
- "tiktokCaption": under 150 characters including 4–6 hashtags
- "pinnedComment": a question to pin that sparks discussion"""
    data = _extract_json(_ask(system, prompt, max_tokens=2000))
    data["generatedBy"] = MODEL
    return data
