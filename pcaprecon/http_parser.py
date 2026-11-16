"""Gap-aware HTTP/1.x parser built on reassembled byte streams.

The parser only ever reads the *contiguous* prefix of a stream.  When
the contiguous bytes run out mid-message, or a reassembly gap starts
inside the message, the message is returned with ``complete=False`` and
an explicit ``incomplete_reason`` — a request/response can therefore
never look complete while bytes are actually missing.

Implemented by hand (no third-party HTTP library) so that framing,
chunked encoding, pipelining and provenance all stay under our control.
"""

from __future__ import annotations

from typing import Optional

from .models import Anomaly, HttpMessage, Session
from .reassembly import DirectedStream

_METHODS = {
    b"GET", b"POST", b"PUT", b"DELETE", b"HEAD", b"OPTIONS", b"PATCH",
    b"TRACE", b"CONNECT",
}
_NO_BODY_STATUSES = {204, 304}
_REQUEST_NO_BODY_METHODS = {b"HEAD"}


class HttpStreamParser:
    def __init__(self, session_id: str, direction: str,
                 stream: DirectedStream):
        self.session_id = session_id
        self.direction = direction  # c2s -> request, s2c -> response
        self.kind = "request" if direction == "c2s" else "response"
        self.stream = stream
        self.data = bytes(stream.data)
        self.gaps = list(stream.gaps)
        self.cursor = 0
        self.seq_no = 0
        self.messages: list[HttpMessage] = []
        self.anomalies: list[Anomaly] = []
        # Once a message cannot be completed (EOF/gap), later bytes can
        # no longer be framed reliably: stop instead of looping forever.
        self.blocked = False
        # Response parsers get request methods so HEAD replies (which
        # never carry a body despite framing headers) parse correctly.
        self.request_methods: list[str] = []

    # ------------------------------------------------------------------

    def parse(self) -> list[HttpMessage]:
        if not self.data:
            return self.messages
        if not self._looks_like_http():
            # Deterministic non-HTTP cleartext stream (binary protocol,
            # TLS missed by detection, ...).  Do not fabricate a message.
            self.blocked = True
            self.anomalies.append(self._anomaly(
                "HTTP_MALFORMED",
                f"{self.kind} stream does not begin with an HTTP/1.x "
                f"start line: {bytes(self.data[:32])!r}", offset=0))
            return self.messages
        while not self.blocked and self.cursor < len(self.data):
            if self._gap_at(self.cursor):
                # Unparseable bytes after a hole; report once and stop.
                self.anomalies.append(self._anomaly(
                    "HTTP_DATA_AFTER_GAP",
                    f"{self.kind} data begins inside a reassembly gap at "
                    f"stream offset {self.cursor}; remaining bytes cannot "
                    "be framed", offset=self.cursor))
                self.blocked = True
                break
            msg = self._parse_message()
            if msg is None:
                self.blocked = True
                break
            self.messages.append(msg)
            if not msg.complete:
                self.blocked = True
                break
            # A 1xx interim response never answers a request and does
            # not consume a response slot; keep parsing for the final
            # status.  It also must not advance the HEAD index.
            if msg.is_interim:
                continue
            self.seq_no += 1
        self._mark_incomplete_tail()
        return self.messages

    # -- message framing ------------------------------------------------

    def _parse_message(self) -> Optional[HttpMessage]:
        start = self.cursor
        mid = f"{self.session_id}-{self.direction}-{self.seq_no + 1}"
        msg = HttpMessage(
            message_id=mid, direction=self.kind, stream=self.direction,
            start_offset=start, end_offset=None)
        msg.frame_numbers = self._frames_for(start, 1)

        line_end = self._find(b"\r\n", self.cursor)
        if line_end is None:
            return self._incomplete(msg, "start line terminated by EOF; "
                                    "capture or response truncated")
        line = self.data[self.cursor:line_end]
        self.cursor = line_end + 2
        if not self._parse_start_line(msg, line):
            # Not HTTP at all (e.g. TLS missed by detection, or a binary
            # protocol).  Record the anomaly and stop without appending a
            # bogus message so the session is not labelled HTTP.
            self.anomalies.append(self._anomaly(
                "HTTP_MALFORMED",
                f"unparseable {self.kind} start line at offset {start}: "
                f"{line[:64]!r}", offset=start))
            self.blocked = True
            return None

        if not self._parse_headers(msg):
            return self._incomplete(msg, "header block incomplete at EOF "
                                    "or reassembly gap")
        if not self._parse_body(msg):
            # _parse_body already recorded the incomplete reason.
            return msg
        msg.complete = True
        msg.end_offset = self.cursor
        msg.provenance = self._provenance(start, self.cursor - start)
        return msg

    def _parse_start_line(self, msg: HttpMessage, line: bytes) -> bool:
        parts = line.split(b" ")
        if self.kind == "request":
            if len(parts) < 3:
                return False
            method, target, version = parts[0], parts[1], parts[-1]
            if method not in _METHODS:
                self.anomalies.append(self._anomaly(
                    "HTTP_UNKNOWN_METHOD",
                    f"unknown HTTP method {method!r} at offset "
                    f"{msg.start_offset}", offset=msg.start_offset))
            if not version.startswith(b"HTTP/1."):
                return False
            msg.method = method.decode("latin1")
            msg.target = target.decode("latin1")
            msg.version = version.decode("latin1")
            self._split_target(msg)
            return True
        # response line
        if len(parts) < 2 or not parts[0].startswith(b"HTTP/"):
            return False
        msg.version = parts[0].decode("latin1")
        try:
            msg.status_code = int(parts[1])
        except ValueError:
            return False
        msg.reason = b" ".join(parts[2:]).decode("latin1", "replace")
        if 100 <= msg.status_code < 200:
            msg.is_interim = True
        return True

    def _split_target(self, msg: HttpMessage) -> None:
        target = msg.target or ""
        # Absolute-form proxy requests: http://host/path?query
        rest = target
        if "://" in rest:
            rest = rest.split("://", 1)[1]
            if "@" in rest.split("/", 1)[0]:
                # userinfo present; path/query still extracted below
                pass
            rest = rest.split("/", 1)
            path = "/" + rest[1] if len(rest) == 2 else "/"
        else:
            path = rest
        if "?" in path:
            msg.path, msg.query = path.split("?", 1)
        else:
            msg.path, msg.query = path, None

    def _parse_headers(self, msg: HttpMessage) -> bool:
        while True:
            if self._gap_at(self.cursor):
                return False
            line_end = self._find(b"\r\n", self.cursor)
            if line_end is None:
                return False
            line = self.data[self.cursor:line_end]
            self.cursor = line_end + 2
            if line == b"":
                return True
            if line[:1] in (b" ", b"\t"):  # obsolete line folding
                if msg.headers:
                    name, value = msg.headers[-1]
                    msg.headers[-1] = (
                        name, value + " " + line.strip().decode("latin1"))
                continue
            if b":" not in line:
                self.anomalies.append(self._anomaly(
                    "HTTP_MALFORMED_HEADER",
                    f"header without colon at offset {line_end}",
                    offset=self.cursor))
                continue
            name, value = line.split(b":", 1)
            msg.headers.append(
                (name.decode("latin1").strip(),
                 value.decode("latin1").strip()))

    def _parse_body(self, msg: HttpMessage) -> bool:
        te = (msg.header("Transfer-Encoding") or "").lower()
        clen_raw = msg.header("Content-Length")

        if self.kind == "response" and msg.status_code and (
                msg.status_code < 200 or
                msg.status_code in _NO_BODY_STATUSES or
                self._method_was_head()):
            return True
        if self.kind == "request" and msg.method and \
                msg.method in ("HEAD",):
            return True

        if "chunked" in te:
            return self._parse_chunked(msg)
        if clen_raw is not None:
            return self._parse_content_length(msg, clen_raw)
        # No framing: a response body runs until connection close.  A
        # request without Content-Length/chunked normally has no body,
        # so trailing bytes are a legitimate pipelined next request —
        # except for methods that semantically carry a body (POST/PUT/
        # PATCH), where undelimited trailing bytes cannot be framed
        # reliably and must not be guessed into a second request.
        if self.kind == "request":
            body_methods = {"POST", "PUT", "PATCH"}
            if msg.method in body_methods and self.cursor < len(self.data):
                self._incomplete(
                    msg, "request carries bytes without "
                    "Content-Length/Transfer-Encoding framing; body "
                    "boundary cannot be determined")
                return False
            return True
        return self._parse_until_close(msg)

    def _method_was_head(self) -> bool:
        idx = self.seq_no
        return idx < len(self.request_methods) and \
            self.request_methods[idx] == "HEAD"

    def _parse_content_length(self, msg: HttpMessage,
                              clen_raw: str) -> bool:
        try:
            length = int(clen_raw.split(",")[0].strip())
        except ValueError:
            self.anomalies.append(self._anomaly(
                "HTTP_BAD_CONTENT_LENGTH",
                f"invalid Content-Length {clen_raw!r}",
                offset=self.cursor))
            self._incomplete(msg, "invalid Content-Length")
            return False
        if length < 0:
            self.anomalies.append(self._anomaly(
                "HTTP_BAD_CONTENT_LENGTH",
                f"negative Content-Length {clen_raw!r}",
                offset=self.cursor))
            self._incomplete(msg, "negative Content-Length")
            return False
        msg.body_transfer = "content-length"
        end = self.cursor + length
        if self._gap_in_range(self.cursor, end):
            self._incomplete(
                msg, f"body declared as {length} bytes but a reassembly "
                "gap overlaps it; body bytes are missing")
            return False
        if end > len(self.data):
            if self._stream_closed_cleanly():
                self._incomplete(
                    msg, f"body declares {length} bytes but stream ended "
                    f"after {len(self.data) - self.cursor}; capture "
                    "truncated")
            else:
                self._incomplete(
                    msg, f"body declares {length} bytes, only "
                    f"{len(self.data) - self.cursor} contiguous bytes "
                    "available so far")
            return False
        msg.body = bytes(self.data[self.cursor:end])
        self.cursor = end
        return True

    def _parse_chunked(self, msg: HttpMessage) -> bool:
        msg.body_transfer = "chunked"
        body = bytearray()
        while True:
            if self._gap_at(self.cursor):
                self._incomplete(
                    msg, "reassembly gap inside chunked body")
                return False
            line_end = self._find(b"\r\n", self.cursor)
            if line_end is None:
                self._incomplete(
                    msg, "chunk size line incomplete at EOF")
                return False
            size_line = self.data[self.cursor:line_end].split(b";", 1)[0]
            try:
                chunk_size = int(size_line, 16)
            except ValueError:
                self.anomalies.append(self._anomaly(
                    "HTTP_BAD_CHUNK",
                    f"invalid chunk size {size_line!r}",
                    offset=self.cursor))
                self._incomplete(msg, "invalid chunk size")
                return False
            self.cursor = line_end + 2
            if chunk_size == 0:
                # Terminating chunk has no data.  Consume optional
                # trailer headers up to and including the empty line.
                while True:
                    trailer_end = self._find(b"\r\n", self.cursor)
                    if trailer_end is None:
                        self._incomplete(
                            msg, "chunked terminator/trailer incomplete "
                            "at EOF")
                        return False
                    trailer = self.data[self.cursor:trailer_end]
                    self.cursor = trailer_end + 2
                    if trailer == b"":
                        break
                msg.body = bytes(body)
                return True
            chunk_end = self.cursor + chunk_size
            if self._gap_in_range(self.cursor, chunk_end + 2):
                self._incomplete(
                    msg, "reassembly gap or truncation inside chunk data")
                return False
            if chunk_end + 2 > len(self.data):
                self._incomplete(
                    msg, "chunk data incomplete at EOF / capture cut")
                return False
            body.extend(self.data[self.cursor:chunk_end])
            if self.data[chunk_end:chunk_end + 2] != b"\r\n":
                self.anomalies.append(self._anomaly(
                    "HTTP_BAD_CHUNK",
                    "chunk not terminated by CRLF", offset=chunk_end))
                self._incomplete(msg, "malformed chunk terminator")
                return False
            self.cursor = chunk_end + 2

    def _parse_until_close(self, msg: HttpMessage) -> bool:
        msg.body_transfer = "until-close"
        if self._gap_at(self.cursor) or self.gaps:
            self._incomplete(
                msg, "body has no Content-Length and a reassembly gap "
                "exists; the body boundary cannot be determined")
            return False
        msg.body = bytes(self.data[self.cursor:])
        msg.frame_numbers = self._frames_for(
            msg.start_offset, len(self.data) - msg.start_offset)
        self.cursor = len(self.data)
        if not self._stream_closed_cleanly():
            self._incomplete(
                msg, "body framed by connection close but the stream was "
                "still open when capture ended")
            return False
        return True

    def _looks_like_http(self) -> bool:
        """Classify the stream from its first line.

        A request starts with a known method token; a response starts
        with ``HTTP/``.  Anything else (binary protocol, misdetected
        TLS) is treated as non-HTTP rather than guessed into a message.
        """
        first_crlf = self.data.find(b"\r\n")
        first_line = self.data if first_crlf == -1 \
            else self.data[:first_crlf]
        if self.kind == "response":
            return first_line.startswith(b"HTTP/")
        token = first_line.split(b" ", 1)[0]
        return token in _METHODS

    def _incomplete(self, msg: HttpMessage, reason: str) -> HttpMessage:
        msg.complete = False
        msg.incomplete_reason = reason
        if "HTTP_INCOMPLETE" not in msg.anomaly_codes:
            msg.anomaly_codes.append("HTTP_INCOMPLETE")
        end = min(self.cursor, len(self.data))
        msg.end_offset = end
        msg.provenance = self._provenance(
            msg.start_offset, max(1, end - msg.start_offset))
        self.anomalies.append(self._anomaly(
            "HTTP_INCOMPLETE",
            f"{self.kind} at offset {msg.start_offset} incomplete: "
            f"{reason}", offset=msg.start_offset))
        return msg

    def _mark_incomplete_tail(self) -> None:
        # If a gap starts after the last complete message, the bytes
        # before it were consumed; nothing else to do.  This hook exists
        # so callers can rely on every message carrying provenance.
        for msg in self.messages:
            if not msg.complete and not msg.incomplete_reason:
                msg.incomplete_reason = "unknown framing failure"

    def _stream_closed_cleanly(self) -> bool:
        return self.stream.fin_abs_seq is not None and not self.stream.reset

    def _find(self, needle: bytes, start: int) -> Optional[int]:
        idx = self.data.find(needle, start)
        if idx == -1:
            return None
        return idx

    def _gap_at(self, offset: int) -> bool:
        return any(g.start <= offset < g.end for g in self.gaps)

    def _gap_in_range(self, start: int, end: int) -> bool:
        return any(not (g.end <= start or g.start >= end)
                   for g in self.gaps)

    def _frames_for(self, offset: int, length: int) -> list[int]:
        return sorted({f.frame_number for f in
                       self.stream.provenance_at(offset, max(1, length))})

    def _provenance(self, offset: int, length: int) -> list[dict]:
        return [{
            "stream_offset": f.stream_offset,
            "length": f.length,
            "frame_number": f.frame_number,
            "file_offset": f.packet_file_offset,
        } for f in self.stream.provenance_at(offset, max(1, length))]

    def _anomaly(self, code: str, message: str,
                 offset: Optional[int] = None) -> Anomaly:
        return Anomaly(code=code, severity="warning", message=message,
                       session_id=self.session_id, stream_offset=offset)


# ---------------------------------------------------------------------------
# Session-level entry point
# ---------------------------------------------------------------------------


def parse_session_http(session: Session) -> list[Anomaly]:
    """Parse both directions of a cleartext session and pair messages."""
    anomalies: list[Anomaly] = []
    if session.encrypted:
        return anomalies

    req_parser = HttpStreamParser(session.session_id, "c2s", session.c2s)
    resp_parser = HttpStreamParser(session.session_id, "s2c", session.s2c)
    requests = req_parser.parse()
    resp_parser.request_methods = [m.method or "" for m in requests]
    responses = resp_parser.parse()
    anomalies.extend(req_parser.anomalies)
    anomalies.extend(resp_parser.anomalies)

    session.messages.extend(requests)
    session.messages.extend(responses)
    if requests or responses:
        session.has_http = True

    # HTTP/1.x final responses are ordered identically to requests on
    # one connection, including pipelined ones.  1xx interim messages
    # are not answers and are excluded from pairing.
    final_responses = [m for m in responses if not m.is_interim]
    for request, response in zip(requests, final_responses):
        response.paired_request_id = request.message_id
    if len(final_responses) > len(requests):
        for orphan in final_responses[len(requests):]:
            orphan.anomaly_codes.append("HTTP_ORPHAN_RESPONSE")
            anomalies.append(Anomaly(
                "HTTP_ORPHAN_RESPONSE", "warning",
                f"response {orphan.message_id} has no matching request",
                session_id=session.session_id,
                stream_offset=orphan.start_offset))
    if len(requests) > len(final_responses):
        for pending in requests[len(final_responses):]:
            if pending.complete and not session.truncated:
                pending.anomaly_codes.append("HTTP_UNPAIRED_REQUEST")
                anomalies.append(Anomaly(
                    "HTTP_UNPAIRED_REQUEST", "warning",
                    f"request {pending.message_id} has no response",
                    session_id=session.session_id,
                    stream_offset=pending.start_offset))
            elif not pending.paired_request_id:
                pending.incomplete_reason = (
                    pending.incomplete_reason or
                    "request sent but no response captured")
    return anomalies
