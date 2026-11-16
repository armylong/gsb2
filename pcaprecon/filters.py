"""Session / message / anomaly filters shared by the CLI and exporter."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .models import HttpMessage, Session


@dataclass
class Filter:
    endpoint: Optional[str] = None        # substring of either endpoint
    start_after: Optional[float] = None   # epoch seconds
    start_before: Optional[float] = None
    method: Optional[str] = None          # HTTP method, case-insensitive
    path_contains: Optional[str] = None   # substring of request path/target
    anomaly: Optional[str] = None         # anomaly code substring
    encrypted_only: bool = False

    def session_matches(self, session: Session) -> bool:
        if self.endpoint:
            ep = self.endpoint
            if ep not in str(session.client) and ep not in str(session.server):
                return False
        if self.start_after is not None and \
                session.start_time < self.start_after:
            return False
        if self.start_before is not None and \
                session.start_time > self.start_before:
            return False
        if self.encrypted_only and not session.encrypted:
            return False
        if self.method or self.path_contains:
            if not any(self._message_matches(m) for m in session.messages):
                return False
        if self.anomaly:
            code = self.anomaly.lower()
            if not any(code in a.code.lower() for a in session.anomalies):
                return False
        return True

    def filter_sessions(self, sessions: list[Session]) -> list[Session]:
        return [s for s in sessions if self.session_matches(s)]

    def filter_messages(self, messages: list[HttpMessage]
                        ) -> list[HttpMessage]:
        return [m for m in messages if self._message_matches(m)]

    def _message_matches(self, msg: HttpMessage) -> bool:
        if self.method and (
                not msg.method or
                msg.method.upper() != self.method.upper()):
            return False
        if self.path_contains:
            haystack = f"{msg.path or ''} {msg.target or ''}"
            if self.path_contains not in haystack:
                return False
        if self.anomaly and not any(
                self.anomaly.lower() in c.lower()
                for c in msg.anomaly_codes):
            return False
        return True

    @staticmethod
    def from_cli(ns) -> "Filter":
        return Filter(
            endpoint=ns.filter_endpoint,
            start_after=ns.filter_start_after,
            start_before=ns.filter_start_before,
            method=ns.filter_method,
            path_contains=ns.filter_path,
            anomaly=ns.filter_anomaly,
            encrypted_only=ns.filter_encrypted)
