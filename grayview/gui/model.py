"""GUI 与解码之间的会话模型：文件字节 + 两套解释参数 + 两个解码结果。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..decode import Decoded, decode
from ..layout import Interpretation, ParamError


@dataclass
class Slot:
    label: str
    interp: Interpretation
    decoded: Decoded | None = None
    error: str = ""

    def refresh(self, data: bytes) -> None:
        try:
            self.decoded = decode(data, self.interp)
            self.error = ""
        except ParamError as exc:
            self.decoded = None
            self.error = str(exc)


@dataclass
class Session:
    data: bytes = b""
    path: Path | None = None
    slots: list[Slot] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.slots:
            default = Interpretation(64, 64)
            self.slots = [
                Slot("A", default, decode(b"", default)),
                Slot("B", default, decode(b"", default)),
            ]

    @property
    def has_file(self) -> bool:
        return self.path is not None

    def open_file(self, path: str | Path) -> None:
        p = Path(path)
        self.data = p.read_bytes()
        self.path = p
        self.refresh_all()

    def set_data(self, data: bytes, path: Path | None, label: str | None = None) -> None:
        self.data = data
        self.path = path
        self.refresh_all()

    def refresh_all(self) -> None:
        for slot in self.slots:
            slot.refresh(self.data)

    def set_interp(self, index: int, interp: Interpretation) -> None:
        self.slots[index].interp = interp
        self.slots[index].refresh(self.data)

    def decoded(self, index: int) -> Decoded | None:
        return self.slots[index].decoded
