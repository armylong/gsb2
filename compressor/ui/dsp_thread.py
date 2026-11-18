"""DSP 调度：C 加速后单次处理约 10ms，直接在 GUI 线程通过空闲定时器重算。

用 QTimer.singleShot(0) 把处理推迟到当前事件（含控件重绘）之后，
既保持拖动 spinbox 时界面响应，又保证“显示的永远是最新参数的结果”，
不存在后台线程的代际竞争或旧结果残留。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QTimer

from ..dsp import CompressorParams, process


class DspRunner:
    def __init__(self, on_done, on_error=None) -> None:
        self._on_done = on_done
        self._on_error = on_error
        self._timer = QTimer()
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self._run)
        self._pending: tuple[int, np.ndarray, int,
                             CompressorParams] | None = None
        self._gen = 0

    def submit(self, gen: int, x: np.ndarray, fs: int,
               params: CompressorParams) -> None:
        self._pending = (gen, x, fs, params)
        self._gen = gen
        self._timer.start(0)

    def _run(self) -> None:
        if self._pending is None:
            return
        gen, x, fs, params = self._pending
        self._pending = None
        try:
            result = process(x, fs, params)
        except Exception as exc:  # pragma: no cover - 防御
            if self._on_error is not None:
                self._on_error(str(exc))
            return
        # 若等待期间又提交了更新版本，先跑最新版本
        if self._pending is not None:
            QTimer.singleShot(0, self._run)
            return
        self._on_done(gen, result)

    def shutdown(self) -> None:
        self._timer.stop()
        self._pending = None
