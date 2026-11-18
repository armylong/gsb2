"""QThread 后台任务: 导入视频与生成样例, 避免阻塞 UI。"""
from __future__ import annotations

import os
import shutil
import tempfile

from PySide6.QtCore import QThread, Signal

from . import probe, samples


class LoadWorker(QThread):
    """导入并解码一个视频文件。"""

    finished_ok = Signal(object)          # probe.InputVideo
    failed = Signal(str)
    progress = Signal(int, int)

    def __init__(self, path: str, parent=None):
        super().__init__(parent)
        self._path = path
        self._work_dir = tempfile.mkdtemp(prefix="fpsc_load_")

    def run(self) -> None:
        try:
            video = probe.load_video(
                self._path, self._work_dir,
                progress=lambda c, t: self.progress.emit(c, t),
            )
        except Exception as exc:  # noqa: BLE001 - 线程内统一转信号
            shutil.rmtree(self._work_dir, ignore_errors=True)
            self.failed.emit(str(exc))
            return
        self.finished_ok.emit(video)

    def cleanup_dir(self) -> None:
        shutil.rmtree(self._work_dir, ignore_errors=True)


class SampleWorker(QThread):
    """生成内置 CFR / VFR 样例。"""

    finished_ok = Signal(dict)
    failed = Signal(str)

    def __init__(self, out_dir: str, parent=None):
        super().__init__(parent)
        self._out_dir = out_dir
        self._work_dir = tempfile.mkdtemp(prefix="fpsc_sample_")

    def run(self) -> None:
        try:
            paths = samples.generate_all(self._work_dir, self._out_dir)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))
            return
        self.finished_ok.emit(paths)

    def cleanup_dir(self) -> None:
        shutil.rmtree(self._work_dir, ignore_errors=True)
