"""后台渲染线程：滑杆连续拖动时只保留最新一帧请求，界面不阻塞。"""

from __future__ import annotations

import time

import numpy as np
from PySide6.QtCore import QObject, QThread, Signal, Slot

from . import engine


class RenderWorker(QObject):
    # 外部请求：跨线程排队投递；忙时只刷新 _pending，天然合并连续拖动
    render_requested = Signal(object, object)  # image, GlowParams
    # 内部重投：当前帧做完后若有更新参数，再排队处理下一帧
    _kick = Signal()
    finished = Signal(object, float)           # RenderResult, 耗时秒
    failed = Signal(str)

    def __init__(self) -> None:
        super().__init__()
        self._image: np.ndarray | None = None
        self._pending: engine.GlowParams | None = None
        self.render_requested.connect(self._on_request)
        self._kick.connect(self._process)

    @Slot(object, object)
    def _on_request(self, image: np.ndarray, params: engine.GlowParams) -> None:
        self._image = image
        self._pending = params
        self._kick.emit()  # 排队到本线程事件循环，槽函数不会重入

    @Slot()
    def _process(self) -> None:
        if self._pending is None:
            return
        params = self._pending
        self._pending = None
        try:
            t0 = time.perf_counter()
            result = engine.render(self._image, params)
            dt = time.perf_counter() - t0
        except Exception as exc:  # noqa: BLE001 — 界面上展示即可
            self.failed.emit(str(exc))
            return
        self.finished.emit(result, dt)
        if self._pending is not None:
            self._kick.emit()


class WorkerThread:
    """封装 QThread 生命周期。"""

    def __init__(self) -> None:
        self.thread = QThread()
        self.worker = RenderWorker()
        self.worker.moveToThread(self.thread)
        self.thread.start()

    def request(self, image: np.ndarray, params: engine.GlowParams) -> None:
        self.worker.render_requested.emit(image, params)

    def shutdown(self) -> None:
        self.thread.quit()
        self.thread.wait(3000)
