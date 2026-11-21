"""后台任务：所有 ffmpeg 调用都放在 QThreadPool 里，避免界面卡死。

注意：``QRunnable`` 默认在 ``run()`` 结束后被 C++ 侧立即删除；跨线程的信号
是排队投递的，如果此时 QObject 已经被销毁就会报 “Signal source has been
deleted”。这里关闭自动删除，并由模块级集合持有引用，直到任务真正结束。
"""

from __future__ import annotations

import inspect
import traceback
from typing import Callable

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal

from . import ffmpeg

_LIVE_TASKS: set["Task"] = set()


class TaskSignals(QObject):
    progress = Signal(int, str)      # 百分比, 说明
    finished = Signal(object)        # 结果
    failed = Signal(str, str)        # 摘要, 详情


class Task(QRunnable):
    """把一个可调用对象放到线程池执行。

    若可调用对象声明了 ``emit_progress`` 参数，会收到 ``(percent, message)``。
    """

    def __init__(self, fn: Callable[..., object], *args, **kwargs):
        super().__init__()
        self.fn = fn
        self.args = args
        self.kwargs = kwargs
        self.signals = TaskSignals()
        self.setAutoDelete(False)
        self._wants_progress = _accepts(fn, "emit_progress")

    def run(self) -> None:  # noqa: D401
        try:
            if self._wants_progress:
                def emit_progress(pct: int, msg: str) -> None:
                    self.signals.progress.emit(int(pct), msg)
                result = self.fn(*self.args, emit_progress=emit_progress, **self.kwargs)
            else:
                result = self.fn(*self.args, **self.kwargs)
        except ffmpeg.FFmpegError as exc:
            self.signals.failed.emit(str(exc), str(getattr(exc, "stderr", "") or ""))
            return
        except Exception as exc:  # noqa: BLE001 - 后台任务统一兜底
            self.signals.failed.emit(f"{type(exc).__name__}: {exc}",
                                     traceback.format_exc())
            return
        self.signals.finished.emit(result)


def _accepts(fn: Callable, name: str) -> bool:
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    if name in params:
        return True
    return any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


def submit(fn: Callable[..., object], *args,
           on_done: Callable[[object], None] | None = None,
           on_error: Callable[[str, str], None] | None = None,
           on_progress: Callable[[int, str], None] | None = None,
           **kwargs) -> Task:
    task = Task(fn, *args, **kwargs)
    if on_done:
        task.signals.finished.connect(on_done)
    if on_error:
        task.signals.failed.connect(on_error)
    if on_progress:
        task.signals.progress.connect(on_progress)

    def _release(*_: object) -> None:
        _LIVE_TASKS.discard(task)

    task.signals.finished.connect(_release)
    task.signals.failed.connect(_release)
    _LIVE_TASKS.add(task)
    QThreadPool.globalInstance().start(task)
    return task
