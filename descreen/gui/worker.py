"""后台处理线程：每次都从原图重算，避免界面卡顿。"""

from __future__ import annotations

from dataclasses import replace

import numpy as np
from PySide6.QtCore import QThread, Signal

from ..core import NotchGroup, descreen, signed_diff


class ProcessWorker(QThread):
    done = Signal(object, object)       # processed(uint8), diff(uint8)
    failed = Signal(str)

    def __init__(self, image: np.ndarray, groups: list[NotchGroup],
                 feather_cpp: float, diff_gain: float, parent=None):
        super().__init__(parent)
        self._image = image
        # 深拷贝一份，主线程随后怎么改都不影响本次计算
        self._groups = [
            replace(g, notches=[replace(n) for n in g.notches])
            for g in groups
        ]
        self._feather = feather_cpp
        self._gain = diff_gain

    def run(self):
        try:
            processed = descreen(self._image, self._groups, self._feather)
            diff = signed_diff(self._image, processed, self._gain)
            self.done.emit(processed, diff)
        except Exception as exc:  # 界面上给出原因，不吞异常
            self.failed.emit(f"{type(exc).__name__}: {exc}")
