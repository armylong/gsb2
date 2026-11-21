"""音频回放: QtMultimedia (QMediaPlayer, 支持精确区间循环) 优先, afplay 回退."""

from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import tempfile

import numpy as np

from .wavio import WavData, save_wav

try:  # pragma: no cover - 依赖运行环境
    from PySide6.QtCore import QUrl
    from PySide6.QtMultimedia import QMediaDevices, QMediaPlayer

    _HAVE_QT_MULTIMEDIA = True
except Exception:  # pragma: no cover
    _HAVE_QT_MULTIMEDIA = False


class _QtMediaPlayer:
    def __init__(self) -> None:
        self._player = QMediaPlayer()
        self._tmpdir = tempfile.mkdtemp(prefix="spikefix_play_")
        self._seq = 0
        self._rate = 48000
        self._loop = False
        atexit.register(self.stop)
        atexit.register(lambda: shutil.rmtree(self._tmpdir, ignore_errors=True))
        if hasattr(QMediaPlayer, "Loops"):
            self._infinite = QMediaPlayer.Loops.Infinite
        else:  # pragma: no cover
            self._infinite = QMediaPlayer.Infinite

    @property
    def available(self) -> bool:
        return True

    @property
    def playing(self) -> bool:
        return self._player.playbackState() == QMediaPlayer.PlaybackState.PlayingState

    def play(self, wav: WavData, start_frame: int, end_frame: int, loop: bool) -> None:
        start_frame = max(0, min(int(start_frame), wav.frames))
        end_frame = max(start_frame, min(int(end_frame), wav.frames))
        if end_frame <= start_frame:
            return
        seg = np.ascontiguousarray(wav.samples[start_frame:end_frame])
        self._seq += 1
        path = os.path.join(self._tmpdir, f"seg_{self._seq}.wav")
        out = WavData(seg, wav.sample_rate, 32, 3)
        save_wav(path, out)
        self._rate = wav.sample_rate
        self._player.stop()
        self._player.setSource(QUrl.fromLocalFile(path))
        self._loop = bool(loop)
        self._player.setLoops(self._infinite if self._loop else 1)
        self._player.play()

    def stop(self) -> None:
        try:
            self._player.stop()
        except Exception:
            pass

    def position_frames(self) -> int | None:
        if not self.playing:
            return None
        ms = self._player.position()
        return int(ms * self._rate / 1000)


class _AfplayPlayer:
    """回退后端 (无 QtMultimedia 时): 写临时 wav 交给 afplay."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._tmpdir = tempfile.mkdtemp(prefix="spikefix_play_")
        self._seq = 0
        atexit.register(self.stop)
        atexit.register(lambda: shutil.rmtree(self._tmpdir, ignore_errors=True))

    @property
    def available(self) -> bool:
        return True

    @property
    def playing(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def play(self, wav: WavData, start_frame: int, end_frame: int, loop: bool) -> None:
        self.stop()
        start_frame = max(0, min(int(start_frame), wav.frames))
        end_frame = max(start_frame, min(int(end_frame), wav.frames))
        if end_frame <= start_frame:
            return
        seg = np.ascontiguousarray(wav.samples[start_frame:end_frame])
        self._seq += 1
        path = os.path.join(self._tmpdir, f"seg_{self._seq}.wav")
        save_wav(path, WavData(seg, wav.sample_rate, 32, 3))
        # afplay 自带循环参数 --loop 0 为无限循环
        cmd = ["afplay"]
        if loop:
            cmd += ["--loop", "0"]
        cmd.append(path)
        self._proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)

    def stop(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.terminate()
            except Exception:
                pass
        self._proc = None

    def position_frames(self) -> int | None:
        return None


class AudioEngine:
    def __init__(self) -> None:
        self._impl = None
        if _HAVE_QT_MULTIMEDIA:
            try:
                if QMediaDevices.defaultAudioOutput().isNull():
                    raise RuntimeError("没有默认音频输出设备")
                self._impl = _QtMediaPlayer()
            except Exception:
                self._impl = None
        if self._impl is None and shutil.which("afplay"):
            self._impl = _AfplayPlayer()

    @property
    def backend(self) -> str:
        if isinstance(self._impl, _QtMediaPlayer):
            return "QtMultimedia"
        if isinstance(self._impl, _AfplayPlayer):
            return "afplay"
        return "无音频后端"

    @property
    def available(self) -> bool:
        return self._impl is not None

    @property
    def playing(self) -> bool:
        return bool(self._impl and self._impl.playing)

    def play(self, wav: WavData, start_frame: int, end_frame: int, loop: bool = False) -> None:
        if self._impl is not None:
            self._impl.play(wav, start_frame, end_frame, loop)

    def stop(self) -> None:
        if self._impl is not None:
            self._impl.stop()

    def position_frames(self) -> int | None:
        return self._impl.position_frames() if self._impl is not None else None
