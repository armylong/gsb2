"""工作线程: 生成测试片 / 识别与匹配, 避免阻塞界面."""

from __future__ import annotations

import traceback
from typing import Any

from PySide6.QtCore import QObject, Signal, Slot

from . import analyzer, generator


class GenerateWorker(QObject):
    progress = Signal(str)
    finished = Signal(object, str)   # plan dict, film path
    failed = Signal(str)

    def __init__(self, film_path: str, options: dict[str, Any]):
        super().__init__()
        self._path = film_path
        self._options = dict(options)

    @Slot()
    def run(self) -> None:
        try:
            profile = self._options.pop("profile", None)
            self.progress.emit(f"正在生成 {profile or '自定义'} 测试片…")
            if profile:
                plan = generator.make_fault_profile(self._path, profile, **self._options)
            else:
                plan = generator.generate_film(self._path, **self._options)
            self.progress.emit("生成完成")
            self.finished.emit(plan, self._path)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"{exc}\n\n{traceback.format_exc(limit=4)}")


class AnalyzeWorker(QObject):
    """解码识别; match=False 时只产出 Analysis (用于重新打开已保存的报告)."""

    progress = Signal(str)
    finished = Signal(object, object)   # Analysis, report dict 或 None
    failed = Signal(str)

    def __init__(self, film_path: str, plan: dict[str, Any] | None, *, match: bool = True):
        super().__init__()
        self._path = film_path
        self._plan = plan
        self._match = match

    @Slot()
    def run(self) -> None:
        try:
            self.progress.emit("解码画面并识别闪光标记…")
            analysis = analyzer.analyze_film(self._path)
            self.progress.emit(
                f"画面检出 {len(analysis.video_detections)} 个, "
                f"声音检出 {len(analysis.audio_detections)} 个"
                + ("; 正在与计划对齐…" if self._match else ""))
            if not self._match:
                self.finished.emit(analysis, None)
                return
            if self._plan is None:
                plan = {"markers": [], "video": None, "audio": None, "faults": {},
                        "plan_path": None}
            else:
                plan = self._plan
            plan.setdefault("plan_path", None)
            report = analyzer.match_plan(analysis, plan)
            report["analysis_tmpdir"] = analysis.tmpdir
            self.finished.emit(analysis, report)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"{exc}\n\n{traceback.format_exc(limit=4)}")
