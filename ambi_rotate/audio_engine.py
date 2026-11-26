"""QAudioSink 拉模式实时回放: 逐块做 FOA 旋转 + 立体声解码。

回放与 dsp.render_stereo 共用同一套旋转/解码函数与 1024 样本块策略,
自动化播放时两者逐样本一致(仅 int16 量化不同)。
"""

from __future__ import annotations

import math
import threading

import numpy as np
from PySide6.QtCore import QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices

from .dsp import (
    MODE_FULL,
    YawMarkers,
    decode_stereo,
    level_db,
    rotate_yaw,
)

BLOCK = 1024
SMOOTH_TAU = 0.02  # 手动朝向平滑时间常数, 消除咔哒声


class _PullDevice(QIODevice):
    def __init__(self, engine: "AudioEngine"):
        super().__init__()
        self._engine = engine

    def readData(self, maxlen: int) -> bytes:
        return self._engine.pull_bytes(maxlen)

    def writeData(self, data) -> int:  # pragma: no cover - 只读设备
        return 0


class AudioEngine(QObject):
    positionChanged = Signal(int)          # 当前帧
    levelsChanged = Signal(list, bool)     # [(rms_db, peak_db) x2], 是否削波
    stateChanged = Signal(str)             # playing / paused / stopped
    errorOccurred = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._lock = threading.RLock()
        self._b: np.ndarray | None = None
        self._sr = 48000
        self._pos = 0
        self._range = (0, 0)
        self._mode = MODE_FULL
        self._angle = 90.0
        self._target_yaw = 0.0
        self._yaw_state = 0.0
        self._automation: YawMarkers | None = None
        self._volume = 1.0
        self._clip_count = 0
        self._loop = False
        self._sink: QAudioSink | None = None
        self._dev: _PullDevice | None = None
        self._poll = QTimer(self)
        self._poll.setInterval(40)
        self._poll.timeout.connect(lambda: self.positionChanged.emit(self._pos))

    # ------------------------------------------------------------------ 参数
    def set_source(self, b: np.ndarray, sr: int) -> None:
        with self._lock:
            self._b = np.asarray(b, dtype=np.float64)
            self._sr = sr
            self._pos = 0
            self._range = (0, self._b.shape[0])
            self._yaw_state = self._target_yaw

    @property
    def frame_count(self) -> int:
        return 0 if self._b is None else self._b.shape[0]

    @property
    def sample_rate(self) -> int:
        return self._sr

    def set_range(self, start_frame: int, end_frame: int) -> None:
        with self._lock:
            n = self.frame_count
            self._range = (max(0, start_frame), min(n, end_frame))
            if not (self._range[0] <= self._pos < self._range[1]):
                self._pos = self._range[0]

    def set_params(self, *, mode=None, speaker_angle=None, yaw_deg=None,
                   automation: YawMarkers | None = None, volume=None) -> None:
        with self._lock:
            if mode is not None:
                self._mode = mode
            if speaker_angle is not None:
                self._angle = float(speaker_angle)
            if yaw_deg is not None:
                self._target_yaw = math.radians(yaw_deg)
            if automation is not None:
                self._automation = automation
            if volume is not None:
                self._volume = float(volume)

    def set_automation(self, automation: YawMarkers | None) -> None:
        with self._lock:
            self._automation = automation
            if automation is not None and automation.markers:
                # 切到自动化时对齐状态, 避免跳变
                self._yaw_state = math.radians(
                    automation.yaw_at(self._pos / self._sr))

    def set_loop(self, loop: bool) -> None:
        self._loop = loop

    def seek(self, frame: int) -> None:
        with self._lock:
            i0, i1 = self._range
            self._pos = min(max(i0, frame), max(i0, i1 - 1))
            if self._automation is not None and self._automation.markers:
                self._yaw_state = math.radians(
                    self._automation.yaw_at(self._pos / self._sr))
        self.positionChanged.emit(self._pos)

    # ------------------------------------------------------------------ 控制
    def play(self) -> None:
        if self._b is None:
            return
        if self._sink is None:
            fmt = QAudioFormat()
            fmt.setSampleRate(self._sr)
            fmt.setChannelCount(2)
            fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
            if QMediaDevices.defaultAudioOutput() is None:
                self.errorOccurred.emit("未找到音频输出设备")
                return
            self._sink = QAudioSink(QMediaDevices.defaultAudioOutput(), fmt, self)
            self._dev = _PullDevice(self)
            self._dev.open(QIODevice.OpenModeFlag.ReadOnly)
            self._sink.start(self._dev)
        else:
            self._sink.resume()
        if self._pos >= self._range[1]:
            self._pos = self._range[0]
        self._poll.start()
        self.stateChanged.emit("playing")

    def pause(self) -> None:
        if self._sink is not None:
            self._sink.suspend()
        self._poll.stop()
        self.stateChanged.emit("paused")

    def stop(self) -> None:
        if self._sink is not None:
            self._sink.stop()
        self._poll.stop()
        with self._lock:
            self._pos = self._range[0]
        self.positionChanged.emit(self._pos)
        self.stateChanged.emit("stopped")

    def teardown(self) -> None:
        self._poll.stop()
        if self._sink is not None:
            self._sink.stop()
            self._sink = None
            self._dev = None

    # ------------------------------------------------------------- 音频回调
    def _current_yaw(self, block_frames: int) -> float:
        t = self._pos / self._sr
        if self._automation is not None and self._automation.markers:
            yaw = math.radians(self._automation.yaw_at(t))
            self._yaw_state = yaw
            return yaw
        # 手动: 最短角差平滑, 跨界不反绕
        delta = (self._target_yaw - self._yaw_state + math.pi) % (2 * math.pi) - math.pi
        coeff = 1.0 - math.exp(-block_frames / self._sr / SMOOTH_TAU)
        self._yaw_state += delta * coeff
        return self._yaw_state

    def pull_bytes(self, maxlen: int) -> bytes:
        with self._lock:
            if self._b is None:
                return b"\x00" * maxlen
            frames_need = maxlen // 4  # 2ch * int16
            out_chunks: list[np.ndarray] = []
            produced = 0
            clipped = False
            while produced < frames_need:
                i0, i1 = self._range
                if self._pos >= i1:
                    if self._loop:
                        self._pos = i0
                    else:
                        break
                n = min(BLOCK, i1 - self._pos, frames_need - produced)
                yaw = self._current_yaw(n)
                block = self._b[self._pos:self._pos + n]
                rot = rotate_yaw(block, yaw)
                st = decode_stereo(rot, self._angle, self._mode) * self._volume
                if np.max(np.abs(st)) > 1.0:
                    clipped = True
                out_chunks.append(st)
                self._pos += n
                produced += n
            if not out_chunks:
                # 播放到末尾: 静音补齐并通知停止
                QTimer.singleShot(0, self._on_natural_end)
                return b"\x00" * maxlen
            stereo = np.concatenate(out_chunks, axis=0)
            if stereo.shape[0] < frames_need:
                pad = np.zeros((frames_need - stereo.shape[0], 2))
                stereo = np.vstack([stereo, pad])
            meters = [level_db(stereo[:, 0]), level_db(stereo[:, 1])]
            if clipped:
                self._clip_count += 1
            QTimer.singleShot(0, lambda: self.levelsChanged.emit(meters, clipped))
            q = np.clip(stereo, -1.0, 1.0)
            q = np.round(q * 32767.0).astype("<i2")
            return q.tobytes()

    def _on_natural_end(self) -> None:
        if self._loop:
            return
        if self._sink is not None and self._pos >= self._range[1]:
            self.pause()
            self.stateChanged.emit("stopped")
            self.positionChanged.emit(self._pos)
