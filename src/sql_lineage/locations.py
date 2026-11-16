"""Source-text positioning helpers.

sqlglot only stores line/col/start/end on leaf nodes (identifiers, literals,
the ``*`` token, ...). Composite nodes get a span by taking the union of every
positioned descendant. When a node has no positioned descendant (rare, e.g.
some synthetic nodes), we fall back to a textual search of its generated SQL
in the original text; if that fails too, location is ``None`` rather than a
wrong guess.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlglot import exp
from sqlglot.dialects.sqlite import SQLite
from sqlglot.tokens import TokenType

from .models import Location


@dataclass
class RawStatement:
    """One semicolon-delimited statement plus its offset in the file text."""

    text: str
    offset: int
    ordinal: int


def split_statements(sql_text: str) -> list[RawStatement]:
    """Split a script into top-level statements using sqlite tokenization.

    Tokenizing first means semicolons inside string literals or comments do
    not split anything. A trailing fragment without a semicolon is returned as
    a statement as well.
    """

    tokens = SQLite().tokenize(sql_text)
    statements: list[RawStatement] = []
    start = 0
    ordinal = 0

    for token in tokens:
        if token.token_type is TokenType.SEMICOLON:
            raw = sql_text[start : token.start]
            stripped = raw.strip()
            if stripped:
                # Offset must point at the first non-whitespace character so it
                # stays consistent with the stripped text used for parsing.
                first_char = start + (len(raw) - len(raw.lstrip()))
                statements.append(
                    RawStatement(text=stripped, offset=first_char, ordinal=ordinal)
                )
                ordinal += 1
            start = token.end + 1

    tail = sql_text[start:].strip()
    if tail:
        # Find the real offset of the first non-whitespace character.
        tail_offset = start + (len(sql_text[start:]) - len(sql_text[start:].lstrip()))
        statements.append(RawStatement(text=tail, offset=tail_offset, ordinal=ordinal))

    return statements


def _positioned_descendants(node: exp.Expr) -> list[tuple[int, int, int, int]]:
    found: list[tuple[int, int, int, int]] = []
    for descendant in node.walk():
        meta = descendant._meta
        if meta and "start" in meta and "end" in meta:
            found.append((meta["start"], meta["end"], meta["line"], meta["col"]))
    return found


def node_location(node: exp.Expr | None, file: str, source_text: str) -> Location | None:
    """Best-effort source location for any AST node."""

    if node is None:
        return None

    positioned = _positioned_descendants(node)
    if positioned:
        start = min(p[0] for p in positioned)
        end = max(p[1] for p in positioned)
        first = min(positioned, key=lambda p: p[0])
        snippet = source_text[start : end + 1].strip()
        return Location(
            file=file,
            line=first[2],
            col=first[3],
            start=start,
            end=end + 1,
            snippet=_shorten(snippet),
        )

    # Fallback: locate the generated SQL text.
    generated = node.sql(dialect="sqlite")
    if generated:
        idx = source_text.find(generated)
        if idx >= 0:
            line = source_text.count("\n", 0, idx) + 1
            line_start = source_text.rfind("\n", 0, idx) + 1
            col = idx - line_start + 1
            return Location(
                file=file,
                line=line,
                col=col,
                start=idx,
                end=idx + len(generated),
                snippet=_shorten(generated),
            )
    return None


def _shorten(text: str, limit: int = 200) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def parse_error_location(error: Exception, file: str, source_text: str) -> Location | None:
    """Extract a position from a sqlglot ParseError.

    ParseError carries a list of error dicts with line/col; the token text is
    also embedded, which gives us a usable snippet even without char offsets.
    """

    errors = getattr(error, "errors", None) or []
    for err in errors:
        line = err.get("line")
        col = err.get("col")
        highlight = err.get("highlight") or ""
        if line is not None and col is not None:
            start, end = _locate_token(source_text, line, col, highlight)
            if highlight and start is not None:
                snippet = source_text[start:end]
            else:
                # No token text: fall back to the parser's context strings.
                snippet = (
                    err.get("start_context", "")
                    + highlight
                    + err.get("end_context", "")
                ).strip()
                start = start if start is not None else _offset_for_line_col(
                    source_text, line, col
                )
                end = start
            return Location(
                file=file,
                line=line,
                col=col,
                start=start,
                end=end,
                snippet=_shorten(snippet),
            )
    return None


def _locate_token(
    text: str, line: int, col: int, token: str
) -> tuple[int | None, int | None]:
    """Find the char span of ``token`` on the given line.

    sqlglot's reported column may point at either end of the offending token,
    so the token text is located within the target line directly rather than
    trusting the column as a start offset.
    """

    if not token:
        return None, None

    line_start = _offset_for_line_col(text, line, 1)
    next_newline = text.find("\n", line_start)
    line_end = len(text) if next_newline < 0 else next_newline
    line_text = text[line_start:line_end]

    col_idx = col - 1
    # Prefer an occurrence that contains the reported column; otherwise take
    # the nearest occurrence on the line.
    candidates = [
        i for i in range(len(line_text))
        if line_text[i : i + len(token)] == token
    ]
    if not candidates:
        return None, None
    containing = [i for i in candidates if i <= col_idx <= i + len(token)]
    chosen = containing[0] if containing else min(
        candidates, key=lambda i: abs(i - col_idx)
    )
    return line_start + chosen, line_start + chosen + len(token)


def _offset_for_line_col(text: str, line: int, col: int) -> int:
    offset = 0
    for _ in range(line - 1):
        newline = text.find("\n", offset)
        if newline < 0:
            return offset
        offset = newline + 1
    return offset + max(col - 1, 0)
