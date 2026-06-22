import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from threading import RLock


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class SessionRecord:
    session_id: str
    collection_name: str
    page_url: str | None
    page_title: str | None
    created_at: datetime
    last_accessed_at: datetime
    review_count: int = 0
    chunk_count: int = 0
    chat_history: list[dict[str, str]] = field(default_factory=list)
    conversation_summary: str = ""


class SessionManager:
    def __init__(self) -> None:
        self.ttl_minutes = int(os.getenv("RAG_SESSION_TTL_MINUTES", "60"))
        self.collection_prefix = os.getenv("RAG_COLLECTION_PREFIX", "review_session")
        self._sessions: dict[str, SessionRecord] = {}
        self._lock = RLock()

    def create_session(
        self,
        page_url: str | None,
        page_title: str | None,
    ) -> SessionRecord:
        session_id = str(uuid.uuid4())
        collection_name = self._collection_name_for_session(session_id)
        now = utc_now()

        record = SessionRecord(
            session_id=session_id,
            collection_name=collection_name,
            page_url=page_url,
            page_title=page_title,
            created_at=now,
            last_accessed_at=now,
        )

        with self._lock:
            self._sessions[session_id] = record

        return record

    def get_session(self, session_id: str) -> SessionRecord | None:
        with self._lock:
            record = self._sessions.get(session_id)

            if record is None:
                return None

            record.last_accessed_at = utc_now()
            return record

    def update_counts(
        self,
        session_id: str,
        review_count: int,
        chunk_count: int,
    ) -> None:
        with self._lock:
            record = self._sessions.get(session_id)

            if record is None:
                raise KeyError(f"Session not found: {session_id}")

            record.review_count = review_count
            record.chunk_count = chunk_count
            record.last_accessed_at = utc_now()

    def append_chat_message(
        self,
        session_id: str,
        role: str,
        content: str,
    ) -> None:
        with self._lock:
            record = self._sessions.get(session_id)

            if record is None:
                raise KeyError(f"Session not found: {session_id}")

            record.chat_history.append(
                {
                    "role": role,
                    "content": content,
                }
            )

            record.last_accessed_at = utc_now()

    def delete_session(self, session_id: str) -> SessionRecord | None:
        with self._lock:
            return self._sessions.pop(session_id, None)

    def cleanup_expired_sessions(self) -> list[SessionRecord]:
        expired: list[SessionRecord] = []
        now = utc_now()
        ttl = timedelta(minutes=self.ttl_minutes)

        with self._lock:
            for session_id, record in list(self._sessions.items()):
                if now - record.last_accessed_at > ttl:
                    expired.append(record)
                    self._sessions.pop(session_id, None)

        return expired

    def expires_at(self, record: SessionRecord) -> datetime:
        return record.last_accessed_at + timedelta(minutes=self.ttl_minutes)

    def _collection_name_for_session(self, session_id: str) -> str:
        safe_id = session_id.replace("-", "")
        return f"{self.collection_prefix}_{safe_id}"

    def update_conversation_memory(
        self,
        session_id: str,
        conversation_summary: str,
        recent_chat_history: list[dict[str, str]],
    ) -> None:
        with self._lock:
            record = self._sessions.get(session_id)

            if record is None:
                raise KeyError(f"Session not found: {session_id}")

            record.conversation_summary = conversation_summary
            record.chat_history = list(recent_chat_history)
            record.last_accessed_at = utc_now()

    
