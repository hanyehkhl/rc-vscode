from __future__ import annotations

from ..contracts.models import Finding
from ..contracts.state import SessionState

CONTEXT_LIMIT = 128_000


def detect(state: SessionState) -> Finding | None:
    ratio = state.context_tokens / CONTEXT_LIMIT if CONTEXT_LIMIT else 0
    if ratio < 0.75:
        return None
    return Finding(
        id="context_bloat",
        severity="red" if ratio > 0.9 else "amber",
        evidence=f"Context is ~{int(ratio * 100)}% full ({state.context_tokens:,} tokens).",
        remedy="Start a new chat or narrow @mentions to specific files.",
    )
