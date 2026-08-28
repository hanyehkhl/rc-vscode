from __future__ import annotations

from ..contracts.models import Finding
from ..contracts.state import SessionState


def detect(state: SessionState) -> Finding | None:
    if state.consecutive_searches < 3:
        return None
    return Finding(
        id="wander",
        severity="amber",
        evidence=f"{state.consecutive_searches} search-class tool calls without an edit.",
        remedy="Name the target file or ask for a plan before exploring further.",
    )
