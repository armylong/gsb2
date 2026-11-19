"""后台渲染队列：保证"旧参数的结果"永远不会冒充最新预览/成品。

* 每次参数或素材变化都 ``submit`` 一个新任务，并带单调递增的序号。
* worker 线程只渲染最新提交的任务；渲染完成后把结果连同序号交回。
* 结果跨线程进入 Qt 主线程时，再次核对序号，不一致就丢弃。
"""

from __future__ import annotations

import threading
import traceback
from collections.abc import Callable
from dataclasses import dataclass

from PySide6.QtCore import QObject, Qt, Signal

from .audio_io import LoadedAudio
from .dsp import RenderResult, ReverbParams, render


@dataclass(frozen=True)
class RenderRequest:
    serial: int
    dry: LoadedAudio
    ir: LoadedAudio
    params: ReverbParams


class RenderJob:
    """单次提交的句柄。"""

    def __init__(self, serial: int, key: tuple) -> None:
        self.serial = serial
        self.key = key


class RenderWorker:
    """单线程渲染器，永远只保留最新待办。"""

    def __init__(self) -> None:
        self._lock = threading.Condition()
        self._pending: RenderRequest | None = None
        self._serial = 0
        self._latest_submitted = 0
        self._thread: threading.Thread | None = None
        self._stop = False
        self.on_result: Callable[[RenderRequest, RenderResult], None] | None = None
        self.on_error: Callable[[RenderRequest, BaseException], None] | None = None

    def submit(self, dry: LoadedAudio, ir: LoadedAudio, params: ReverbParams) -> RenderJob:
        with self._lock:
            self._serial += 1
            serial = self._serial
            self._pending = RenderRequest(serial=serial, dry=dry, ir=ir, params=params)
            self._latest_submitted = serial
            self._lock.notify()
        return RenderJob(serial=serial, key=params.key(dry.sample_rate))

    def latest_serial(self) -> int:
        with self._lock:
            return self._latest_submitted

    def is_latest(self, job: RenderJob | int) -> bool:
        serial = job.serial if isinstance(job, RenderJob) else int(job)
        with self._lock:
            return serial == self._latest_submitted

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop = False
        self._thread = threading.Thread(
            target=self._run, name="reverb-renderer", daemon=True
        )
        self._thread.start()

    def shutdown(self) -> None:
        with self._lock:
            self._stop = True
            self._pending = None
            self._lock.notify()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        self._thread = None

    def _run(self) -> None:
        while True:
            with self._lock:
                while self._pending is None and not self._stop:
                    self._lock.wait()
                if self._stop:
                    return
                request = self._pending
                self._pending = None
            assert request is not None
            try:
                result = render(request.dry, request.ir, request.params)
            except BaseException as exc:  # 渲染失败需要显示给用户
                traceback.print_exc()
                if self.on_error is not None:
                    self.on_error(request, exc)
                continue
            with self._lock:
                stale = request.serial != self._latest_submitted
            if stale:
                continue  # 渲染期间参数又变了：旧结果不回调
            if self.on_result is not None:
                self.on_result(request, result)


class RenderController(QObject):
    """把 worker 结果排队送回 Qt 主线程，并再次校验序号。"""

    _ready = Signal(int, object)
    _failed = Signal(int, str)

    def __init__(self, on_ready, on_error=None, parent=None) -> None:
        super().__init__(parent)
        self._on_ready = on_ready
        self._on_error = on_error
        self._worker = RenderWorker()
        self._worker.on_result = self._emit_result
        self._worker.on_error = self._emit_error
        self._ready.connect(self._handle_ready, Qt.ConnectionType.QueuedConnection)
        self._failed.connect(self._handle_error, Qt.ConnectionType.QueuedConnection)
        self._worker.start()

    def submit(self, dry: LoadedAudio, ir: LoadedAudio, params: ReverbParams) -> RenderJob:
        return self._worker.submit(dry, ir, params)

    def is_latest(self, job: RenderJob | int) -> bool:
        return self._worker.is_latest(job)

    def _emit_result(self, request: RenderRequest, result: RenderResult) -> None:
        self._ready.emit(request.serial, result)

    def _emit_error(self, request: RenderRequest, exc: BaseException) -> None:
        self._failed.emit(request.serial, f"{type(exc).__name__}: {exc}")

    def _handle_ready(self, serial: int, result: RenderResult) -> None:
        if not self._worker.is_latest(serial):
            return
        if self._on_ready is not None:
            self._on_ready(result, serial)

    def _handle_error(self, serial: int, message: str) -> None:
        if not self._worker.is_latest(serial):
            return
        if self._on_error is not None:
            self._on_error(message)

    def shutdown(self) -> None:
        self._worker.shutdown()
