"""GUI 与引擎之间的后台线程、图像转换等辅助工具。"""
from __future__ import annotations

import os

import cv2
import numpy as np
from PySide6.QtCore import QObject, QThread, Signal
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtWidgets import QMessageBox


def safe_message(parent, level: str, title: str, text: str) -> int:
    """模态消息框；offscreen 无窗口环境下降级为打印，避免永久阻塞。"""
    if os.environ.get("QT_QPA_PLATFORM") == "offscreen":
        print(f"[{level}] {title}: {text}")
        return QMessageBox.Ok
    box = {
        "warning": QMessageBox.warning,
        "critical": QMessageBox.critical,
        "information": QMessageBox.information,
    }[level]
    return box(parent, title, text)


def cv_to_qpixmap(img_bgr: np.ndarray) -> QPixmap:
    """OpenCV BGR/BGRA 图像转 QPixmap。"""
    if img_bgr.ndim == 2:
        h, w = img_bgr.shape
        qimg = QImage(img_bgr.data, w, h, w, QImage.Format_Grayscale8)
    elif img_bgr.shape[2] == 4:
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGRA2RGBA)
        h, w = rgb.shape[:2]
        qimg = QImage(rgb.data, w, h, 4 * w, QImage.Format_RGBA8888)
    else:
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        qimg = QImage(rgb.data, w, h, 3 * w, QImage.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())


class BuildWorker(QObject):
    """在独立线程执行引擎 rebuild，避免阻塞 UI。"""

    finished = Signal(object)  # BuildReport
    failed = Signal(str)

    def __init__(self, engine):
        super().__init__()
        self._engine = engine

    def run(self) -> None:
        try:
            report = self._engine.rebuild()
        except Exception as exc:  # 界面必须兜底，不让线程异常静默
            self.failed.emit(f"{type(exc).__name__}: {exc}")
            return
        self.finished.emit(report)


def start_build(engine, on_finished, on_failed) -> QThread:
    thread = QThread()
    worker = BuildWorker(engine)
    worker.moveToThread(thread)
    thread.started.connect(worker.run)
    worker.finished.connect(on_finished)
    worker.failed.connect(on_failed)
    worker.finished.connect(thread.quit)
    worker.failed.connect(thread.quit)
    thread.finished.connect(worker.deleteLater)
    thread.finished.connect(thread.deleteLater)
    thread.start()
    return thread
