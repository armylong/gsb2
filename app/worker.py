"""把接缝雕刻放到 QThread 里执行，计算期间窗口保持响应、可取消。"""

from __future__ import annotations

from PySide6.QtCore import QThread, Signal

from content_aware.engine import CarveOutcome, carve_width


class CarveThread(QThread):
    progress = Signal(int, int)          # 已删接缝数 / 计划删除数
    status = Signal(str)
    finished_outcome = Signal(object)    # CarveOutcome

    def __init__(self, image, protected, target_width, parent=None):
        super().__init__(parent)
        self._image = image
        self._protected = protected
        self._target_width = target_width
        self._cancel = False

    def cancel(self) -> None:
        self._cancel = True
        self.status.emit("正在取消，完成当前接缝后停止……")

    def run(self) -> None:  # noqa: D401 - Qt 线程入口
        try:
            outcome: CarveOutcome = carve_width(
                self._image,
                self._protected,
                self._target_width,
                should_cancel=lambda: self._cancel,
                progress=lambda done, total: self.progress.emit(done, total),
            )
        except Exception as exc:  # 非法参数等：包装成信号回主线程
            self.status.emit(f"处理失败：{exc}")
            return
        self.finished_outcome.emit(outcome)
