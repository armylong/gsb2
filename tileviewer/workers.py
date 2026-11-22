"""Background worker for creating / verifying the tile pyramid."""

from __future__ import annotations

import traceback

from PySide6.QtCore import QObject, Signal

from .cache import CacheManager, CancelledError, LevelComparison

__all__ = ["GenerationWorker", "VerificationWorker"]


class GenerationWorker(QObject):
    progress = Signal(int, int, str)
    levelDone = Signal(int)
    finished = Signal(bool, str)  # cancelled, summary
    failed = Signal(str)
    done = Signal()

    def __init__(
        self,
        manager: CacheManager,
        levels: list[int],
        force: bool,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._manager = manager
        self._levels = list(levels)
        self._force = force
        self._cancelled = False
        self._written: list[int] = []

    def cancel(self) -> None:
        self._cancelled = True

    def run(self) -> None:
        try:
            self._manager.write_pyramid_manifest()
            written = self._manager.generate(
                self._levels,
                force=self._force,
                progress=self._on_progress,
                should_cancel=lambda: self._cancelled,
            )
            self._written = written
            summary = (
                "已生成 " + ", ".join(f"L{index:02d}" for index in written)
                if written
                else "所有请求的层级已完整"
            )
            self.finished.emit(False, summary)
        except CancelledError as exc:
            self.finished.emit(True, str(exc))
        except Exception as exc:  # noqa: BLE001 - surfaced in the UI
            traceback.print_exc()
            self.failed.emit(str(exc))
        finally:
            self.done.emit()

    def _on_progress(self, done: int, total: int, message: str) -> None:
        self.progress.emit(done, total, message)


class VerificationWorker(QObject):
    levelCompared = Signal(object)  # LevelComparison
    finished = Signal(str)
    failed = Signal(str)
    done = Signal()

    def __init__(
        self,
        manager: CacheManager,
        levels: list[int],
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._manager = manager
        self._levels = list(levels)
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def run(self) -> None:
        try:
            results: list[LevelComparison] = []
            for index in self._levels:
                if self._cancelled:
                    break
                comparison = self._manager.compare_level(index)
                results.append(comparison)
                self.levelCompared.emit(comparison)
            if results:
                bad = [item for item in results if not item.equal]
                summary = (
                    "全部层级拼接结果与参考图逐像素一致"
                    if not bad
                    else f"{len(bad)} 个层级存在差异"
                )
            else:
                summary = "没有可比对的完整层级"
            self.finished.emit(summary)
        except Exception as exc:  # noqa: BLE001 - surfaced in the UI
            traceback.print_exc()
            self.failed.emit(str(exc))
        finally:
            self.done.emit()
