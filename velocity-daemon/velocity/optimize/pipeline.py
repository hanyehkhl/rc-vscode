from __future__ import annotations

import re

MAX_MENTIONS = 6
MAX_HISTORY_CHARS = 12_000


def bound_mentions(prompt: str) -> str:
    mentions = re.findall(r"(?:^|\s)@([^\s@]+)", prompt)
    if len(mentions) <= MAX_MENTIONS:
        return prompt
    kept = mentions[:MAX_MENTIONS]
    note = (
        f"\n\n[Velocity: trimmed {len(mentions) - MAX_MENTIONS} @mentions "
        f"to keep context lean. Focus on: {', '.join(kept)}]"
    )
    return prompt + note


def compact_history_block(history_text: str) -> str:
    if len(history_text) <= MAX_HISTORY_CHARS:
        return history_text
    head = history_text[:4000].rstrip()
    tail = history_text[-6000:].lstrip()
    return (
        f"{head}\n\n[Velocity: middle of conversation omitted for speed]\n\n{tail}"
    )


def autotune_effort(mode: str, effort: str, prompt: str) -> str:
    if effort != "off":
        return effort
    if mode in {"ask", "plan"}:
        return "off"
    short = len(prompt.strip()) < 240
    if short and "@" not in prompt:
        return "off"
    if any(word in prompt.lower() for word in ("refactor", "architecture", "debug", "migrate")):
        return "low"
    return "off"
