from __future__ import annotations

from dataclasses import dataclass, field

from ..engine import RoiContribution, StackParams, StackResult


@dataclass
class VersionState:
    key: str
    params: StackParams
    result: StackResult | None = None
    error: str | None = None
    source_overlay: bool = False
    roi: tuple[int, int, int, int] | None = None
    contributors: list[RoiContribution] = field(default_factory=list)
    info: str = "尚未计算"
