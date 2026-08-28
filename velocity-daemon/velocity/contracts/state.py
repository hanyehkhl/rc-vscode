from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


Verdict = Literal["productive", "exploratory", "wandering", "blocked", "thrash"]


@dataclass
class TurnRecord:
    turn_id: str
    tool_calls: list[str] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    verdict: Verdict = "productive"


@dataclass
class SessionState:
    thread_id: str
    session_id: str = ""
    context_tokens: int = 0
    turns: list[TurnRecord] = field(default_factory=list)
    consecutive_searches: int = 0
    last_edit_turn: int = 0
    tool_signatures: dict[str, int] = field(default_factory=dict)

    def record_tool(self, tool_name: str, signature: str) -> None:
        self.tool_calls_recent = getattr(self, "tool_calls_recent", [])
        normalized = tool_name.lower()
        self.tool_calls_recent.append(normalized)
        self.tool_signatures[signature] = self.tool_signatures.get(signature, 0) + 1
        if normalized in {"grep", "glob", "search", "read_file", "list_dir"}:
            self.consecutive_searches += 1
        elif normalized in {"edit", "write", "notebookedit", "apply_patch"}:
            self.consecutive_searches = 0
            self.last_edit_turn = len(self.turns)
