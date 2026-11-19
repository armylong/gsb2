"""后台线程: 视频解码与三路 FFV1 编码可能耗时, 不阻塞 UI。"""

from __future__ import annotations

from PySide6.QtCore import QThread, Signal

from ..pipeline import Project, build_from_input, generate_synthetic


class BuildWorker(QThread):
    finished_ok = Signal(object)
    failed = Signal(str)

    def __init__(self, kind: str, path: str | None = None,
                 width: int = 640, height: int = 480,
                 frame_count: int = 60, fps: int = 30, parent=None):
        super().__init__(parent)
        self.kind = kind
        self.path = path
        self.width = width
        self.height = height
        self.frame_count = frame_count
        self.fps = fps

    def run(self):
        try:
            if self.kind == "input":
                project = build_from_input(self.path)
            else:
                project = generate_synthetic(
                    width=self.width, height=self.height,
                    frame_count=self.frame_count, fps=self.fps,
                )
        except Exception as exc:  # 界面层需要文本化任何失败原因
            self.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.finished_ok.emit(project)
