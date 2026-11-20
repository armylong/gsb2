"""后台分色线程：只把最慢的色域搜索移出 UI 线程。"""

from __future__ import annotations

from PySide6.QtCore import QObject, QThread, Signal

from ..model import InkParams
from ..separation import separate_image


class SepWorker(QObject):
    finished = Signal(dict, object)  # sep 字典, InkParams
    failed = Signal(str)

    def __init__(self, target_rgb, inks: InkParams, grid_n: int):
        super().__init__()
        self.target = target_rgb
        self.inks = inks
        self.grid_n = grid_n

    def run(self) -> None:
        try:
            sep = separate_image(self.target, self.inks, grid_n=self.grid_n)
            self.finished.emit(sep, self.inks)
        except Exception as exc:  # noqa: BLE001 - 线程边界需要回传任何异常
            self.failed.emit(repr(exc))


def start_worker(target_rgb, inks: InkParams, grid_n: int,
                 on_finished, on_failed) -> tuple[QThread, SepWorker]:
    thread = QThread()
    worker = SepWorker(target_rgb, inks, grid_n)
    worker.moveToThread(thread)
    thread.started.connect(worker.run)
    worker.finished.connect(on_finished)
    worker.failed.connect(on_failed)
    worker.finished.connect(thread.quit)
    worker.failed.connect(thread.quit)
    thread.finished.connect(worker.deleteLater)
    thread.finished.connect(thread.deleteLater)
    # 关键：worker 必须被线程强引用，否则局部变量回收后事件永远无法投递
    thread._worker_ref = worker
    thread.start()
    return thread, worker
