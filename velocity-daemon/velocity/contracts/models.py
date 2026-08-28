from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class Finding(BaseModel):
    id: str
    severity: Literal["info", "amber", "red"]
    evidence: str
    remedy: str = ""


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "rc-default"
    messages: list[ChatMessage]
    stream: bool = False
    mode: str = "write"
    search: bool = False
    thinking_effort: str = "off"
    thread_id: str = "default"
    velocity: bool = True


class ChatResponse(BaseModel):
    id: str = ""
    session_id: str = ""
    content: str
    usage: Usage = Field(default_factory=Usage)
    findings: list[Finding] = Field(default_factory=list)
    stderr: str = ""


class ModuleInfo(BaseModel):
    id: str
    version: str
    enabled: bool = True
    healthy: bool = True


class DoctorReport(BaseModel):
    ok: bool
    daemon_version: str
    rc_serve_url: str
    rc_serve_reachable: bool
    node_path: str
    cli_path: str
    details: dict[str, Any] = Field(default_factory=dict)
