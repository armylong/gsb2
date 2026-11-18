"""后台线程解码的帧缓存。

两段 ≤10 秒的 720p 视频总量不大, 用一个工作线程顺序解码并把每帧转成
JPEG 字节驻留内存(720p 一帧原图约 2.7MB, JPEG 后通常几十 KB),
主线程按需解成 QImage, 拖动时间轴也能即时显示。
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image
from PySide6.QtCore import QObject, QThread, Signal

from ..media import VideoInfo, iter_frames_rgb


class _DecodeWorker(QObject):
    frame_ready = Signal(int, bytes)
    finished = Signal(object)  # None 或异常

    def __init__(self, info: VideoInfo, quality: int = 80) -> None:
        super().__init__()
        self._info = info
        self._quality = quality
        self._stop = False

    def stop(self) -> None:
        self._stop = True

    def run(self) -> None:
        try:
            for i, frame in enumerate(
                iter_frames_rgb(self._info.path, self._info.width, self._info.height)
            ):
                if self._stop:
                    break
                buf = io.BytesIO()
                Image.fromarray(frame).save(buf, format="JPEG", quality=self._quality)
                self.frame_ready.emit(i, buf.getvalue())
            self.finished.emit(None)
        except Exception as exc:  # 回传给主线程弹窗
            self.finished.emit(exc)


class FrameCache(QObject):
    """一段视频的全帧 JPEG 缓存。"""

    frame_loaded = Signal(int)
    load_done = Signal(object)

    def __init__(self, info: VideoInfo) -> None:
        super().__init__()
        self.info = info
        self._jpeg: dict[int, bytes] = {}
        self._thread = QThread()
        self._worker = _DecodeWorker(info)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.frame_ready.connect(self._on_frame)
        self._worker.finished.connect(self._on_finished)

    def start(self) -> None:
        self._thread.start()

    def _on_frame(self, index: int, data: bytes) -> None:
        self._jpeg[index] = data
        self.frame_loaded.emit(index)

    def _on_finished(self, err: object) -> None:
        self._thread.quit()
        self.load_done.emit(err)

    def shutdown(self) -> None:
        self._worker.stop()
        self._thread.quit()
        self._thread.wait(3000)

    def is_ready(self, frame: int) -> bool:
        return frame in self._jpeg

    def loaded_count(self) -> int:
        return len(self._jpeg)

    def frame_numpy(self, frame: int) -> np.ndarray | None:
        data = self._jpeg.get(frame)
        if data is None:
            return None
        return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
