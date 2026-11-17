"""后台导出线程，避免导出大视频时界面卡死。"""

from __future__ import annotations

from PySide6.QtCore import QThread, Signal

from ..exporter import export_video
from ..keying import KeyingParams


class ExportWorker(QThread):
    progress = Signal(int, int)          # done, total
    succeeded = Signal(dict)
    failed = Signal(str)

    def __init__(self, fg_path: str, bg_path: str, out_path: str,
                 params: KeyingParams, parent=None):
        super().__init__(parent)
        self._fg = fg_path
        self._bg = bg_path
        self._out = out_path
        self._params = KeyingParams.from_dict(params.to_dict())

    def run(self) -> None:
        try:
            result = export_video(
                self._fg, self._bg, self._out, self._params,
                progress_cb=lambda done, total: self.progress.emit(done, total),
            )
            self.succeeded.emit(result)
        except Exception as exc:  # 界面层统一展示中文错误
            self.failed.emit(str(exc))
