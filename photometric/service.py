"""Background worker that runs the solver off the UI thread."""
from __future__ import annotations

import time

import numpy as np
from PySide6.QtCore import QObject, QThread, Signal

from .solver import SolverOptions, SolveResult, solve


class _Worker(QObject):
    finished = Signal(object, float)     # result, seconds
    failed = Signal(str)

    def __init__(self, images: np.ndarray, directions: np.ndarray,
                 object_mask: np.ndarray, options: SolverOptions,
                 light_indices: np.ndarray | None = None):
        super().__init__()
        self._images = images
        self._directions = directions
        self._mask = object_mask
        self._options = options
        self._light_indices = light_indices

    def run(self) -> None:
        try:
            start = time.perf_counter()
            result: SolveResult = solve(self._images, self._directions,
                                        self._mask, self._options,
                                        light_indices=self._light_indices)
            self.finished.emit(result, time.perf_counter() - start)
        except Exception as exc:  # pragma: no cover - defensive
            self.failed.emit(str(exc))


class SolveService(QObject):
    """Owns a single background thread, cancelling any previous run."""

    started = Signal()
    finished = Signal(object, float)
    failed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._thread: QThread | None = None
        self._worker: _Worker | None = None
        self._pending: tuple | None = None

    def request(self, images: np.ndarray, directions: np.ndarray,
                object_mask: np.ndarray, options: SolverOptions,
                light_indices: np.ndarray | None = None) -> None:
        if self._thread is not None:
            # one job at a time; remember the latest request
            self._pending = (images, directions, object_mask, options, light_indices)
            return
        self._start(images, directions, object_mask, options, light_indices)

    def _start(self, images, directions, mask, options, light_indices=None) -> None:
        thread = QThread()
        worker = _Worker(images, directions, mask, options, light_indices)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.finished.connect(self._on_finished)
        worker.failed.connect(self._on_failed)
        worker.finished.connect(thread.quit)
        worker.failed.connect(thread.quit)
        thread.finished.connect(thread.deleteLater)
        self._thread = thread
        self._worker = worker
        self.started.emit()
        thread.start()

    def _on_finished(self, result: SolveResult, seconds: float) -> None:
        self._cleanup()
        if self._pending is not None:
            args, self._pending = self._pending, None
            self._start(*args)
            return
        self.finished.emit(result, seconds)

    def _on_failed(self, message: str) -> None:
        self._cleanup()
        self.failed.emit(message)

    def _cleanup(self) -> None:
        if self._thread is not None:
            self._thread.quit()
            self._thread.wait(2000)
        self._thread = None
        self._worker = None

    def shutdown(self) -> None:
        self._pending = None
        self._cleanup()
