from __future__ import annotations

from ..contracts.state import SessionState


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionState] = {}
        self._rp_session_ids: dict[str, str] = {}

    def get(self, thread_id: str) -> SessionState:
        if thread_id not in self._sessions:
            self._sessions[thread_id] = SessionState(thread_id=thread_id)
        return self._sessions[thread_id]

    def get_rp_session(self, thread_id: str) -> str:
        return self._rp_session_ids.get(thread_id, "")

    def set_rp_session(self, thread_id: str, session_id: str) -> None:
        if session_id:
            self._rp_session_ids[thread_id] = session_id
        else:
            self._rp_session_ids.pop(thread_id, None)

    def clear_thread(self, thread_id: str) -> None:
        self._sessions.pop(thread_id, None)
        self._rp_session_ids.pop(thread_id, None)


store = SessionStore()
