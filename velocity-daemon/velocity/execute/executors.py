from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, AsyncIterator

import httpx

from ..contracts.models import ChatResponse, Usage
from ..optimize.pipeline import autotune_effort, bound_mentions, compact_history_block


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _parse_tool_events(stderr: str) -> list[str]:
    tools: list[str] = []
    for line in stderr.splitlines():
        match = re.search(r"Approved tool:\s*(\S+)", line, re.IGNORECASE)
        if match:
            tools.append(match.group(1))
    return tools


class SpawnExecutor:
    """Fallback path: run bundled `rc --plain` as a subprocess."""

    async def complete(
        self,
        *,
        prompt: str,
        mode: str,
        search: bool,
        thinking_effort: str,
        cwd: str,
    ) -> ChatResponse:
        node = _env("RC_VELOCITY_NODE_PATH")
        cli = _env("RC_VELOCITY_CLI_PATH")
        token = _env("RC_VELOCITY_TOKEN") or _env("DEEPSEEK_TOKEN")
        if not node or not cli or not token:
            raise RuntimeError("Velocity spawn executor missing node/cli/token env.")

        optimized = bound_mentions(compact_history_block(prompt))
        effort = autotune_effort(mode, thinking_effort, optimized)
        args = [cli, "--plain", "--mode", mode]
        if search:
            args.append("--search")
        if effort != "off":
            args.extend(["--thinking-effort", effort])
        args.append(optimized)

        env = {**os.environ, "DEEPSEEK_TOKEN": token, "RC_VELOCITY_ENABLED": "1"}
        proc = await asyncio.create_subprocess_exec(
            node,
            *args,
            cwd=cwd or None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await proc.communicate()
        text = stdout.decode("utf-8", errors="replace").strip()
        err = stderr.decode("utf-8", errors="replace").strip()
        ok = proc.returncode == 0 and bool(text)
        if not ok and not text:
            text = err or "Velocity spawn executor failed."
        return ChatResponse(content=text, stderr=err, usage=Usage())


class ServeExecutor:
    """Preferred path: proxy to `rc serve` OpenAI-compatible API."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def health(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/health")
                return response.status_code == 200
        except Exception:
            return False

    async def complete(
        self,
        *,
        prompt: str,
        mode: str,
        search: bool,
        thinking_effort: str,
        thread_id: str,
        rp_session_id: str,
        cwd: str,
    ) -> ChatResponse:
        token = _env("RC_VELOCITY_TOKEN") or _env("DEEPSEEK_TOKEN")
        if not token:
            raise RuntimeError("Velocity serve executor missing token.")

        optimized = bound_mentions(prompt)
        effort = autotune_effort(mode, thinking_effort, optimized)
        headers = {"Authorization": f"Bearer {token}"}
        payload: dict[str, Any] = {
            "model": "rc-default",
            "messages": [{"role": "user", "content": optimized}],
            "stream": False,
            "metadata": {
                "mode": mode,
                "search": search,
                "thinking_effort": effort,
                "cwd": cwd,
            },
        }

        url = f"{self.base_url}/v1/chat/completions"
        if rp_session_id:
            url = f"{url}/{rp_session_id}"

        async with httpx.AsyncClient(timeout=600.0) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()

        session_id = (
            response.headers.get("X-RP-Session-Id")
            or data.get("session_id")
            or rp_session_id
            or ""
        )
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        content = (message.get("content") or "").strip()
        usage_raw = data.get("usage") or {}
        usage = Usage(
            prompt_tokens=int(usage_raw.get("prompt_tokens") or 0),
            completion_tokens=int(usage_raw.get("completion_tokens") or 0),
            total_tokens=int(usage_raw.get("total_tokens") or 0),
        )
        return ChatResponse(id=data.get("id", ""), session_id=session_id, content=content, usage=usage)

    async def stream(
        self,
        *,
        prompt: str,
        mode: str,
        search: bool,
        thinking_effort: str,
        thread_id: str,
        rp_session_id: str,
        cwd: str,
    ) -> AsyncIterator[bytes]:
        token = _env("RC_VELOCITY_TOKEN") or _env("DEEPSEEK_TOKEN")
        if not token:
            raise RuntimeError("Velocity serve executor missing token.")

        optimized = bound_mentions(prompt)
        effort = autotune_effort(mode, thinking_effort, optimized)
        headers = {"Authorization": f"Bearer {token}"}
        payload: dict[str, Any] = {
            "model": "rc-default",
            "messages": [{"role": "user", "content": optimized}],
            "stream": True,
            "stream_options": {"include_usage": True},
            "metadata": {
                "mode": mode,
                "search": search,
                "thinking_effort": effort,
                "cwd": cwd,
            },
        }

        url = f"{self.base_url}/v1/chat/completions"
        if rp_session_id:
            url = f"{url}/{rp_session_id}"

        async with httpx.AsyncClient(timeout=600.0) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    yield chunk


def parse_usage_from_sse(buffer: str) -> Usage:
    usage = Usage()
    for line in buffer.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            continue
        raw = data.get("usage") or {}
        if raw:
            usage = Usage(
                prompt_tokens=int(raw.get("prompt_tokens") or 0),
                completion_tokens=int(raw.get("completion_tokens") or 0),
                total_tokens=int(raw.get("total_tokens") or 0),
            )
    return usage
