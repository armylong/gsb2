"""后台拟合线程, 避免大图阻塞 UI."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QThread, Signal

from ..physics import fit_stack, Thresholds


class FitWorker(QThread):
    finished_ok = Signal(object)          # FitResult
    failed = Signal(str)

    def __init__(self, stack: np.ndarray, angles: list[float],
                 linearize: bool, normalize: bool, thresholds: Thresholds, parent=None):
        super().__init__(parent)
        self._stack = stack
        self._angles = angles
        self._linearize = linearize
        self._normalize = normalize
        self._thresholds = thresholds

    def run(self):
        try:
            result = fit_stack(
                self._stack, self._angles,
                linearize=self._linearize,
                exposure_normalize=self._normalize,
                thresholds=self._thresholds,
            )
            self.finished_ok.emit(result)
        except Exception as exc:  # 送回主线程展示
            self.failed.emit(f"{type(exc).__name__}: {exc}")
