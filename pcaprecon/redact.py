"""Secret / PII redaction applied identically to CLI output and exports.

Redaction is the default; callers must explicitly opt into raw secrets
(``--show-secrets``).  The same code path serves interactive display and
report export so an exported report can never leak what the UI hides.
"""

from __future__ import annotations

import re
from urllib.parse import quote, unquote

from .config import DEFAULT_REDACTION
from .models import HttpMessage, Session

SENSITIVE_HEADERS = {
    "authorization", "proxy-authorization", "cookie", "set-cookie",
    "x-api-key", "x-auth-token", "x-access-token", "x-csrf-token",
    "www-authenticate", "proxy-authenticate",
}
SENSITIVE_QUERY_KEYS = {
    "password", "passwd", "pwd", "secret", "token", "access_token",
    "refresh_token", "api_key", "apikey", "key", "signature", "sig",
    "auth", "credential", "credentials", "session", "sessionid",
    "session_id", "code",
}
SENSITIVE_BODY_KEYS = SENSITIVE_QUERY_KEYS | {
    "username", "user", "login", "email", "mail", "phone",
    "mobile", "id_card", "idcard", "card_number", "cvv", "ssn",
}

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_CN_MOBILE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
_CN_ID_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
# 13-19 digit PAN, keep last 4 digits (PCI friendly display).
_CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")
_BEARER_RE = re.compile(r"(?i)^(bearer|basic|digest|token)\s+")


class Redactor:
    def __init__(self, enabled: bool = True, token: str = DEFAULT_REDACTION):
        self.enabled = enabled
        self.token = token

    # -- scalar helpers -------------------------------------------------

    def text(self, value: str) -> str:
        if not self.enabled or not value:
            return value
        value = _EMAIL_RE.sub(self._mask_email, value)
        value = _CN_ID_RE.sub(self.token, value)
        value = _CN_MOBILE_RE.sub(self._mask_phone, value)
        value = _CARD_RE.sub(self._mask_card, value)
        return value

    def header(self, name: str, value: str) -> str:
        if not self.enabled:
            return value
        if name.lower() in SENSITIVE_HEADERS:
            if _BEARER_RE.match(value):
                scheme = value.split()[0]
                return f"{scheme} {self.token}"
            return self.token
        return self.text(value)

    def userinfo(self, target: str) -> str:
        if not self.enabled or "://" not in target or "@" not in target:
            return target
        scheme, rest = target.split("://", 1)
        hostpart = rest.split("/", 1)[0]
        if "@" not in hostpart:
            return target
        _userinfo, host = hostpart.rsplit("@", 1)
        tail = rest[len(hostpart):]
        return f"{scheme}://{self.token}@{host}{tail}"

    def query(self, query: str | None) -> str | None:
        if not self.enabled or not query:
            return query
        out = []
        for pair in query.split("&"):
            if "=" in pair:
                key, value = pair.split("=", 1)
                if unquote(key).lower() in SENSITIVE_QUERY_KEYS:
                    out.append(f"{key}={quote(self.token, safe='')}")
                else:
                    out.append(f"{key}={self.text(unquote(value))}")
            else:
                out.append(pair)
        return "&".join(out)

    def body_bytes(self, body: bytes,
                   content_type: str | None) -> bytes:
        if not self.enabled or not body:
            return body
        ct = (content_type or "").lower()
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            # Binary body: only strip obvious bearer-style ascii runs.
            return self._redact_ascii_runs(body)
        if "application/json" in ct:
            redacted = self._redact_json(text)
        elif "application/x-www-form-urlencoded" in ct:
            redacted = self.query(text) or ""
        else:
            redacted = self.text(text)
        return redacted.encode("utf-8", "replace")

    # -- message / session views ---------------------------------------

    def view_message(self, msg: HttpMessage) -> dict:
        headers = [(k, self.header(k, v)) for k, v in msg.headers]
        target = self.userinfo(msg.target or "")
        target = self._apply_query_to_target(target)
        body = self.body_bytes(msg.body, msg.header("Content-Type"))
        return {
            "message_id": msg.message_id,
            "direction": msg.direction,
            "stream": msg.stream,
            "method": msg.method,
            "target": target,
            "path": self.text(msg.path) if msg.path else None,
            "query": self.query(msg.query),
            "status_code": msg.status_code,
            "reason": msg.reason,
            "version": msg.version,
            "headers": headers,
            "body": _safe_text(body),
            "body_transfer": msg.body_transfer,
            "complete": msg.complete,
            "incomplete_reason": msg.incomplete_reason,
            "paired_request_id": msg.paired_request_id,
            "is_interim": msg.is_interim,
            "start_offset": msg.start_offset,
            "end_offset": msg.end_offset,
            "frame_numbers": list(msg.frame_numbers),
            "provenance": list(msg.provenance),
            "anomaly_codes": list(msg.anomaly_codes),
        }

    def view_session(self, session: Session) -> dict:
        return {
            "session_id": session.session_id,
            "client": str(session.client),
            "server": str(session.server),
            "start_time": session.start_time,
            "end_time": session.end_time,
            "duration_s": _duration(session),
            "encrypted": session.encrypted,
            "encryption_kind": session.encryption_kind,
            "truncated": session.truncated,
            "reset": session.reset,
            "has_http": session.has_http,
            "frames": len(session.frame_numbers),
            "first_frame": session.first_frame,
            "last_frame": session.last_frame,
            "c2s_bytes": len(session.c2s_data),
            "s2c_bytes": len(session.s2c_data),
            "c2s_gaps": [g.__dict__ for g in session.c2s_gaps],
            "s2c_gaps": [g.__dict__ for g in session.s2c_gaps],
            "retransmissions": session.retransmissions,
            "out_of_order": session.out_of_order,
            "duplicate_segments": session.duplicate_segments,
            "conflict_segments": session.conflict_segments,
            "messages": [self.view_message(m) for m in session.messages],
            "anomalies": [a.to_dict() for a in session.anomalies],
        }

    # -- internals ------------------------------------------------------

    def _apply_query_to_target(self, target: str) -> str:
        if not self.enabled or "?" not in target:
            return target
        base, query = target.split("?", 1)
        return f"{base}?{self.query(query)}"

    def _redact_json(self, text: str) -> str:
        import json
        try:
            obj = json.loads(text)
        except (ValueError, TypeError):
            return self.text(text)
        redacted = self._walk_json(obj)
        return json.dumps(redacted, ensure_ascii=False)

    def _walk_json(self, node):
        if isinstance(node, dict):
            return {k: (self.token if k.lower() in SENSITIVE_BODY_KEYS
                        else self._walk_json(v))
                    for k, v in node.items()}
        if isinstance(node, list):
            return [self._walk_json(v) for v in node]
        if isinstance(node, str):
            return self.text(node)
        return node

    def _redact_ascii_runs(self, body: bytes) -> bytes:
        def repl(match: re.Match) -> bytes:
            return self.token.encode()
        return re.sub(rb"(?i)(?:bearer|basic|token)\s+[A-Za-z0-9+/=._-]+",
                      repl, body)

    def _mask_email(self, match: re.Match) -> str:
        local, _, domain = match.group(0).partition("@")
        return f"{local[0]}{self.token}@{domain}" if local else self.token

    def _mask_phone(self, match: re.Match) -> str:
        digits = match.group(0)
        return digits[:3] + self.token + digits[-2:]

    def _mask_card(self, match: re.Match) -> str:
        digits = re.sub(r"[ -]", "", match.group(0))
        if not 13 <= len(digits) <= 19:
            return match.group(0)
        return f"{self.token}…{digits[-4:]}"


def _duration(session: Session) -> float | None:
    if session.end_time is None:
        return None
    return round(session.end_time - session.start_time, 6)


def _safe_text(body: bytes) -> str:
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return body.decode("latin1", "replace")
