"""后台半色调渲染 worker。

网点渲染是纯 numpy 计算，小周期 + 最大图时可达约 2 秒，放到 QThread 里
避免拖动滑块时界面冻结。每个组只保留最新一次请求；worker 每轮把队列里
各组的最新参数各渲染一次，渲染期间到达的新请求会触发下一轮，因此界面
最终一定与最新参数一致。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QObject, Qt, QThread, Signal, Slot

from halftone.core import HalftoneError, render_halftone


class RenderWorker(QObject):
    # 在 worker 线程发出: 组名、二值图
    rendered = Signal(str, np.ndarray)
    failed = Signal(str, str)

    # 由 RenderService 跨线程触发(队列连接)
    _resetRequested = Signal(np.ndarray)
    _renderRequested = Signal(str, dict)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._gray: np.ndarray | None = None
        self._pending: dict[str, dict] = {}
        self._busy = False
        self._resetRequested.connect(
            self._on_reset, Qt.ConnectionType.QueuedConnection
        )
        self._renderRequested.connect(
            self._on_request, Qt.ConnectionType.QueuedConnection
        )

    @Slot(np.ndarray)
    def _on_reset(self, gray: np.ndarray) -> None:
        self._gray = gray
        self._pending.clear()

    @Slot(str, dict)
    def _on_request(self, group: str, params: dict) -> None:
        self._pending[group] = params
        self._pump()

    def _pump(self) -> None:
        if self._busy or self._gray is None or not self._pending:
            return
        self._busy = True
        jobs = list(self._pending.items())
        self._pending.clear()
        for group, params in jobs:
            # 同组在排队期间又被更新: 只渲染最新值
            if group in self._pending:
                continue
            try:
                binary = render_halftone(self._gray, params)
            except HalftoneError as exc:
                self.failed.emit(group, str(exc))
                continue
            self.rendered.emit(group, binary)
        self._busy = False
        if self._pending:
            self._pump()


class RenderService(QObject):
    """封装长驻 QThread，主窗口只跟这个对象打交道。"""

    rendered = Signal(str, np.ndarray)
    failed = Signal(str, str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._thread = QThread(self)
        self._worker = RenderWorker()
        # 必须先 moveToThread 再建立跨线程信号连接：否则连接在两个对象
        # 尚处于同一线程时被定为直连，信号会在 worker 线程直接触发，
        # 无法排队回到主线程更新界面。
        self._worker.moveToThread(self._thread)
        self._worker.rendered.connect(
            self.rendered, Qt.ConnectionType.QueuedConnection
        )
        self._worker.failed.connect(
            self.failed, Qt.ConnectionType.QueuedConnection
        )
        self._thread.start()

    def reset(self, gray: np.ndarray) -> None:
        self._worker._resetRequested.emit(gray)

    def request(self, group: str, params: dict) -> None:
        self._worker._renderRequested.emit(group, params)

    def shutdown(self) -> None:
        self._thread.quit()
        self._thread.wait(3000)
