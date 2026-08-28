from __future__ import annotations

from ..contracts.models import Finding
from ..contracts.state import SessionState


def detect(state: SessionState) -> Finding | None:
    repeated = [sig for sig, count in state.tool_signatures.items() if count >= 2]
    if not repeated:
        return None
    return Finding(
        id="retry_loop",
        severity="amber",
        evidence=f"Repeated tool call detected ({len(repeated)} duplicate signature(s)).",
        remedy="Stop retrying the same tool; surface the underlying error or change approach.",
    )
