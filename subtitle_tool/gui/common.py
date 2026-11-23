"""Shared GUI helpers: colours, formatting and small widgets."""

from __future__ import annotations

from PySide6.QtGui import QColor, QFont

from ..model import Event, Project

STATUS_COLORS = {
    "ok": QColor("#2e7d32"),
    "warning": QColor("#b26a00"),
    "error": QColor("#c62828"),
    "locked": QColor("#1565c0"),
    "missing": QColor("#8e24aa"),
    "split": QColor("#00695c"),
    "cut": QColor("#d84315"),
}

ROW_LANG_COLORS = {
    0: QColor("#1a237e"),
    1: QColor("#4a148c"),
    2: QColor("#004d40"),
    3: QColor("#5d4037"),
}

MONO_FONT = QFont("Menlo")
MONO_FONT.setStyleHint(QFont.Monospace)
MONO_FONT.setPointSize(11)


def lang_color(index: int) -> QColor:
    return ROW_LANG_COLORS.get(index % len(ROW_LANG_COLORS), QColor("#333333"))


def summarize_text(text: str, limit: int = 48) -> str:
    flat = " / ".join(ln.strip() for ln in text.splitlines() if ln.strip())
    if len(flat) > limit:
        return flat[: limit - 1] + "…"
    return flat


def rows_caption(project: Project, ev: Event) -> str:
    bits = []
    for lang in project.lang_order:
        rows = ev.rows_for(lang)
        if not rows:
            bits.append(f"{project.lang_label(lang)}：缺")
        else:
            count = sum(len(r.lines) for r in rows if r.visible)
            bits.append(f"{project.lang_label(lang)}：{count} 行")
    return "，".join(bits)


