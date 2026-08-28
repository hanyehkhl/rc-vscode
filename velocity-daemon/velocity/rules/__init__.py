from __future__ import annotations

from ..contracts.models import Finding
from ..contracts.state import SessionState
from . import context_bloat, retry_loop, wander

DETECTORS = [context_bloat.detect, wander.detect, retry_loop.detect]


def run_detectors(state: SessionState) -> list[Finding]:
    findings: list[Finding] = []
    for detector in DETECTORS:
        result = detector(state)
        if result is not None:
            findings.append(result)
    return findings
