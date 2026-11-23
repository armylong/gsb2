"""Text splitting helpers shared by manual splits and automatic pairing.

Splitting must respect the script: Latin text breaks at a space, CJK text has
no spaces and must break at punctuation (，。！？、；：…）or between characters,
but never inside an ASCII word.
"""

from __future__ import annotations

from typing import List, Sequence

CJK_BREAK_AFTER = "，。！？；：、…—）」』】》〉,.!?;:"
CJK_BREAK_BEFORE = "（「『【《〈"


def _is_ascii_word_char(ch: str) -> bool:
    return ch.isascii() and (ch.isalnum() or ch in "'-_")


def break_points(text: str) -> List[int]:
    """Indices where the text may be cut (cut *before* the index)."""
    points: List[int] = []
    for i in range(1, len(text)):
        prev, cur = text[i - 1], text[i]
        if prev in CJK_BREAK_AFTER:
            points.append(i)
            continue
        if cur in CJK_BREAK_BEFORE:
            points.append(i)
            continue
        if prev.isspace() and not cur.isspace():
            points.append(i)
            continue
        # between two CJK characters is allowed, but only if neither side is
        # ASCII text (never cut "don't" or "e.g" in half)
        if not _is_ascii_word_char(prev) and not _is_ascii_word_char(cur):
            if not prev.isspace() and not cur.isspace():
                points.append(i)
    return points


def choose_break(text: str, target: int, tolerance: int = 0) -> int:
    """Pick the break index closest to *target*, preferring punctuation.

    *tolerance* also allows the closest punctuation-only break to win when it
    is within that many characters of the closest break.
    """
    target = max(1, min(len(text) - 1, target)) if len(text) > 1 else 0
    if len(text) <= 1:
        return 0
    points = break_points(text)
    if not points:
        return target
    punct = [p for p in points if p >= 1 and text[p - 1] in CJK_BREAK_AFTER]
    pool = punct or points
    best = min(pool, key=lambda p: abs(p - target))
    if tolerance and punct:
        closest = min(points, key=lambda p: abs(p - target))
        near_punct = min(punct, key=lambda p: abs(p - target))
        if abs(near_punct - target) <= tolerance:
            return near_punct
        return closest
    return best


def split_text(text: str, ratio: float) -> tuple:
    """Split *text* into two pieces at approximately *ratio* (0..1)."""
    ratio = min(0.9, max(0.1, ratio))
    if not text.strip():
        return text, ""
    lines = text.split("\n")
    if len(lines) > 1:
        cut = max(1, min(len(lines) - 1, round(len(lines) * ratio)))
        return "\n".join(lines[:cut]), "\n".join(lines[cut:])
    target = int(round(len(text) * ratio))
    target = max(1, min(len(text) - 1, target))
    index = choose_break(text, target, tolerance=max(2, len(text) // 12))
    if index <= 0:
        index = target
    return text[:index].rstrip(), text[index:].lstrip()


def split_text_by_weights(text: str, weights: Sequence[float]) -> List[str]:
    """Split *text* into ``len(weights)`` pieces proportional to weights."""
    text = text.strip()
    if len(weights) == 1:
        return [text]
    total = float(sum(weights)) or 1.0
    parts: List[str] = []
    rest = text
    remaining = total
    for i, weight in enumerate(weights):
        if i == len(weights) - 1:
            parts.append(rest.strip())
            break
        share = weight / remaining if remaining > 0 else 1.0
        target = int(round(len(rest) * share))
        remaining -= weight
        # keep at least one character per remaining piece
        min_left = len(weights) - i - 1
        target = max(1, min(len(rest) - min_left, target))
        index = choose_break(rest, target, tolerance=max(4, len(rest) // 4))
        if index <= 0:
            index = target
        parts.append(rest[:index].strip())
        rest = rest[index:].strip()
    while len(parts) < len(weights):
        parts.append("")
    return parts
