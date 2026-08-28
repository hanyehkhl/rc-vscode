from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .. import __version__
from ..contracts.models import ChatRequest, ChatResponse, DoctorReport, Finding, ModuleInfo
from ..execute.executors import ServeExecutor, SpawnExecutor, _parse_tool_events, parse_usage_from_sse
from ..optimize.pipeline import compact_history_block
from ..rules import run_detectors
from ..state.session_store import store

API_RANGE = "0.1"


def _serve_url() -> str:
    return os.environ.get("RC_VELOCITY_RC_SERVE_URL", "http://127.0.0.1:3001").strip()


def _cwd() -> str:
    return os.environ.get("RC_VELOCITY_CWD", os.getcwd())


def create_app() -> FastAPI:
    app = FastAPI(title="RC Velocity", version=__version__)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    serve = ServeExecutor(_serve_url())
    spawn = SpawnExecutor()

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "velocity_version": __version__,
            "api_range": API_RANGE,
            "rc_serve_reachable": await serve.health(),
        }

    @app.get("/velocity/doctor")
    async def doctor() -> DoctorReport:
        return DoctorReport(
            ok=True,
            daemon_version=__version__,
            rc_serve_url=_serve_url(),
            rc_serve_reachable=await serve.health(),
            node_path=os.environ.get("RC_VELOCITY_NODE_PATH", ""),
            cli_path=os.environ.get("RC_VELOCITY_CLI_PATH", ""),
        )

    @app.get("/velocity/modules")
    async def modules() -> list[ModuleInfo]:
        return [
            ModuleInfo(id="optimize", version="0.1.0", enabled=True, healthy=True),
            ModuleInfo(id="rules", version="0.1.0", enabled=True, healthy=True),
            ModuleInfo(id="serve_executor", version="0.1.0", enabled=await serve.health(), healthy=True),
            ModuleInfo(id="spawn_executor", version="0.1.0", enabled=True, healthy=True),
        ]

    @app.get("/velocity/state/{thread_id}")
    async def velocity_state(thread_id: str) -> dict[str, Any]:
        state = store.get(thread_id)
        return {
            "thread_id": state.thread_id,
            "session_id": store.get_rp_session(thread_id),
            "context_tokens": state.context_tokens,
            "consecutive_searches": state.consecutive_searches,
            "turns": len(state.turns),
        }

    @app.get("/velocity/findings/{thread_id}")
    async def velocity_findings(thread_id: str) -> list[Finding]:
        return run_detectors(store.get(thread_id))

    @app.delete("/velocity/thread/{thread_id}")
    async def clear_thread(thread_id: str) -> dict[str, str]:
        store.clear_thread(thread_id)
        return {"status": "cleared"}

    @app.post("/v1/chat/completions")
    @app.post("/v1/chat/completions/{session_id}")
    async def chat_completions(
        request: Request,
        body: ChatRequest,
        session_id: str = "",
        x_rc_thread_id: str | None = Header(default=None),
    ) -> Any:
        thread_id = x_rc_thread_id or body.thread_id or "default"
        state = store.get(thread_id)
        rp_session = session_id or store.get_rp_session(thread_id)

        user_text = ""
        for message in reversed(body.messages):
            if message.role == "user":
                user_text = message.content
                break
        if not user_text:
            raise HTTPException(status_code=400, detail="No user message in request.")

        prompt = compact_history_block(user_text) if body.velocity else user_text
        mode = body.mode if body.mode in {"ask", "write", "auto", "plan", "normal", "yolo"} else "write"
        cli_mode = "ask" if mode == "ask" else "auto" if mode == "auto" else "write"

        if body.stream and await serve.health():
            async def event_stream():
                buffer = ""
                async for chunk in serve.stream(
                    prompt=prompt,
                    mode=cli_mode,
                    search=body.search,
                    thinking_effort=body.thinking_effort,
                    thread_id=thread_id,
                    rp_session_id=rp_session,
                    cwd=_cwd(),
                ):
                    buffer += chunk.decode("utf-8", errors="replace")
                    yield chunk
                usage = parse_usage_from_sse(buffer)
                if usage.prompt_tokens:
                    state.context_tokens = usage.prompt_tokens
                findings = run_detectors(state)
                meta = {"velocity_findings": [f.model_dump() for f in findings]}
                yield f"data: {json.dumps(meta)}\n\n".encode()

            return StreamingResponse(event_stream(), media_type="text/event-stream")

        if await serve.health():
            result = await serve.complete(
                prompt=prompt,
                mode=cli_mode,
                search=body.search,
                thinking_effort=body.thinking_effort,
                thread_id=thread_id,
                rp_session_id=rp_session,
                cwd=_cwd(),
            )
        else:
            result = await spawn.complete(
                prompt=prompt,
                mode=cli_mode,
                search=body.search,
                thinking_effort=body.thinking_effort,
                cwd=_cwd(),
            )
            for tool in _parse_tool_events(result.stderr):
                state.record_tool(tool, tool)

        if result.session_id:
            store.set_rp_session(thread_id, result.session_id)
            state.session_id = result.session_id
        if result.usage.prompt_tokens:
            state.context_tokens = result.usage.prompt_tokens

        findings = run_detectors(state)
        result.findings = findings
        return result

    return app


def main() -> None:
    import uvicorn

    host = os.environ.get("RC_VELOCITY_HOST", "127.0.0.1")
    port = int(os.environ.get("RC_VELOCITY_PORT", "8790"))
    uvicorn.run("velocity.api.app:create_app", factory=True, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
