"""声音试听: 用操作系统的音频设备播放一小段解码后的采样.

Qt Multimedia 在这里不够稳定(不同机器上的 ffmpeg 后端对短片段和精确 seek 的
支持差异很大), 所以这里用最朴素也最可控的方式: 把一段 WAV 交给系统的
播放器, 或者用 QAudioSink 直接推送 PCM.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
import wave

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices


class AudioPlayer(QObject):
    """播一小段单声道 float 采样.

    Mac 上优先用系统 afplay (延迟低, 不依赖 Qt 的音频后端); 其它平台或
    afplay 不可用时退回 QAudioSink.
    """

    finished = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._proc: subprocess.Popen | None = None
        self._sink: QAudioSink | None = None
        self._buffer: QBuffer | None = None
        self._tmp_path: str | None = None
        self._cooldown = QTimer(self)
        self._cooldown.setSingleShot(True)
        self._cooldown.timeout.connect(self._cleanup_tmp)

    # -- 公共接口 -----------------------------------------------------------
    def play_samples(self, samples: np.ndarray, sample_rate: int, *,
                     gain: float = 1.0) -> bool:
        self.stop()
        if samples is None or len(samples) == 0:
            return False
        mono = np.asarray(samples, dtype=np.float32).reshape(-1)
        peak = float(np.max(np.abs(mono))) or 1.0
        # 太小的片段听不清; 只做温和的归一化, 保留原始相对大小
        if peak < 0.25:
            mono = mono * min(3.0, 0.25 / peak)
        mono = np.clip(mono * gain, -1.0, 1.0)
        pcm = (mono * 32767.0).astype(np.int16)

        afplay = shutil.which("afplay")
        if afplay:
            return self._play_with_afplay(pcm, sample_rate, afplay)
        return self._play_with_qtaudio(pcm, sample_rate)

    def stop(self) -> None:
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=0.2)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self._proc.kill()
                except OSError:
                    pass
            self._proc = None
        if self._sink is not None:
            try:
                self._sink.stop()
            except RuntimeError:
                pass
            self._sink = None
        if self._buffer is not None:
            self._buffer.close()
            self._buffer = None
        self._cleanup_tmp()

    def is_playing(self) -> bool:
        if self._proc is not None and self._proc.poll() is None:
            return True
        if self._sink is not None and self._sink.state() == QAudioSink.ActiveState:
            return True
        return False

    # -- 实现 ---------------------------------------------------------------
    def _wav_bytes(self, pcm: np.ndarray, sample_rate: int) -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(int(sample_rate))
            wf.writeframes(pcm.tobytes())
        return buf.getvalue()

    def _play_with_afplay(self, pcm: np.ndarray, sample_rate: int, exe: str) -> bool:
        self._cleanup_tmp()
        fd, path = tempfile.mkstemp(prefix="syncmark-listen-", suffix=".wav")
        os.close(fd)
        self._tmp_path = path
        with open(path, "wb") as fh:
            fh.write(self._wav_bytes(pcm, sample_rate))
        try:
            self._proc = subprocess.Popen(
                [exe, path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            self._proc = None
            return False
        QTimer.singleShot(self._duration_ms(pcm, sample_rate) + 60, self._maybe_finish)
        return True

    def _play_with_qtaudio(self, pcm: np.ndarray, sample_rate: int) -> bool:
        fmt = QAudioFormat()
        fmt.setSampleRate(int(sample_rate))
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.Int16)
        device = QMediaDevices.defaultAudioOutput()
        if device is None:
            return False
        sink = QAudioSink(device, fmt, self)
        self._sink = sink
        data = QByteArray(pcm.tobytes())
        buf = QBuffer(self)
        buf.setData(data)
        buf.open(QIODevice.ReadOnly)
        self._buffer = buf
        sink.start(buf)
        QTimer.singleShot(self._duration_ms(pcm, sample_rate) + 60, self._maybe_finish)
        return True

    def _duration_ms(self, pcm: np.ndarray, sample_rate: int) -> int:
        return int(round(len(pcm) * 1000.0 / max(1, sample_rate)))

    def _maybe_finish(self) -> None:
        still = self.is_playing()
        if not still:
            self.finished.emit()
            self._cooldown.start(400)

    def _cleanup_tmp(self) -> None:
        if self._tmp_path:
            try:
                if self._proc is not None and self._proc.poll() is None:
                    self._cooldown.start(400)
                    return
                os.unlink(self._tmp_path)
            except OSError:
                pass
            self._tmp_path = None


def audio_available() -> bool:
    try:
        return QMediaDevices.defaultAudioOutput() is not None
    except Exception:
        return False
