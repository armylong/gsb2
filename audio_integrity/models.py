from __future__ import annotations

import math
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

BAND_LOSS = "band_loss"
CHANNEL_LOSS = "channel_loss"
QUIET = "quiet"
MANUAL = "manual"

KIND_LABELS = {
    BAND_LOSS: "频带突断",
    CHANNEL_LOSS: "整路缺音",
    QUIET: "正常安静",
    MANUAL: "人工区间",
}

KIND_COLORS = {
    BAND_LOSS: "#f59e0b",      # amber
    CHANNEL_LOSS: "#ef4444",   # red
    QUIET: "#64748b",          # slate
    MANUAL: "#22c55e",         # green
}

STATUS_LABELS = {
    "suggested": "待确认",
    "confirmed": "已确认",
}


def new_id() -> str:
    return uuid.uuid4().hex[:10]


def json_safe(value: Any) -> Any:
    """Convert numpy / non-finite values to JSON-compatible Python values."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if hasattr(value, "item"):
        try:
            value = value.item()
        except Exception:
            pass
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


@dataclass
class Annotation:
    """A suggested marker or a human-confirmed interval.

    ``channels`` uses zero-based channel indices. An empty list means all
    channels. ``bands`` uses :class:`~audio_integrity.analysis.Band.key`;
    an empty list means the full frequency range.
    """

    start: float
    end: float
    kind: str = BAND_LOSS
    channels: list[int] = field(default_factory=list)
    bands: list[str] = field(default_factory=list)
    status: str = "suggested"
    source: str = "auto"
    label: str = ""
    note: str = ""
    confidence: float | None = None
    metrics: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=new_id)

    def __post_init__(self) -> None:
        self.start = max(0.0, float(self.start))
        self.end = max(self.start, float(self.end))
        if not self.label:
            self.label = KIND_LABELS.get(self.kind, self.kind)

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def is_confirmed(self) -> bool:
        return self.status == "confirmed"

    def confirm(self, note: str | None = None) -> "Annotation":
        self.status = "confirmed"
        self.source = "human"
        if note is not None:
            self.note = note
        return self

    def time_text(self) -> str:
        return f"{self.start:.2f}–{self.end:.2f}s"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["duration"] = self.duration
        data["kind_label"] = KIND_LABELS.get(self.kind, self.kind)
        data["status_label"] = STATUS_LABELS.get(self.status, self.status)
        return json_safe(data)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Annotation":
        allowed = {
            "id", "start", "end", "kind", "channels", "bands", "status",
            "source", "label", "note", "confidence", "metrics",
        }
        kwargs = {k: v for k, v in data.items() if k in allowed}
        return cls(**kwargs)
