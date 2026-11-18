"""QThread 工作线程: 所有 ffmpeg/探测/核对都不阻塞 UI。"""

from __future__ import annotations

import traceback

from PySide6.QtCore import QThread, Signal


class Worker(QThread):
    progress = Signal(str)
    succeeded = Signal(object)
    failed = Signal(str)

    def __init__(self, fn, *args, **kwargs):
        super().__init__()
        self._fn = fn
        self._args = args
        self._kwargs = kwargs

    def run(self) -> None:
        try:
            result = self._fn(
                *self._args,
                progress=self.progress.emit,
                **self._kwargs,
            )
        except Exception as exc:  # 业务异常与意外异常都带回主线程展示
            self.failed.emit(f"{exc}\n\n{traceback.format_exc(limit=2)}")
            return
        self.succeeded.emit(result)
