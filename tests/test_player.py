"""播放引擎的离线测试: 不依赖真实声卡, 用假 sink 验证片段簿记、
重复播放不叠加、停止后状态复位与统一时间指针。"""

from __future__ import annotations

import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication

from audio_repair.player import AudioPlayer

import pytest


@pytest.fixture(scope="module")
def qapp():
    return QApplication.instance() or QApplication([])


class FakeDevice:
    def __init__(self):
        self.written = bytearray()

    def write(self, data: bytes) -> int:
        self.written.extend(data)
        return len(data)


class FakeSink:
    instances: list["FakeSink"] = []

    def __init__(self, fmt, parent=None):
        self._fmt = fmt
        self._free = 1 << 20
        self._processed_us = 0
        self._stopped = False
        self.device = FakeDevice()
        FakeSink.instances.append(self)

    def start(self):
        return self.device

    def bytesFree(self):
        return self._free

    def processedUSecs(self):
        # 模拟设备瞬间播完
        return 1 << 40

    def stop(self):
        self._stopped = True

    def deleteLater(self):
        pass


def test_play_segment_bookkeeping(qapp, monkeypatch):
    import audio_repair.player as mod
    monkeypatch.setattr(mod, "QAudioSink", FakeSink)
    player = AudioPlayer()
    sr = 8000
    audio = np.arange(2 * sr, dtype=np.float64).reshape(-1, 2) / 1000.0
    positions = []
    player.positionChanged.connect(lambda t: positions.append(t))
    player.play_segment(audio, sr, sr // 2, sr)  # 0.5s-1.0s
    # FakeSink.processedUSecs 模拟瞬间播完: 首次 pump 内即自动收尾
    assert not player.is_playing()
    assert player.end_time == pytest.approx(1.0)
    # 写入字节数恰好对应半秒立体声 float32
    expect_bytes = (sr - sr // 2) * 2 * 4
    assert len(FakeSink.instances[-1].device.written) == expect_bytes
    # 播放头从片段起点走到终点 (统一时间参数)
    assert positions[0] == pytest.approx(0.5)
    assert positions[-1] == pytest.approx(1.0)


def test_repeated_play_does_not_stack(qapp, monkeypatch):
    import audio_repair.player as mod
    monkeypatch.setattr(mod, "QAudioSink", FakeSink)
    player = AudioPlayer()
    sr = 8000
    audio = np.zeros(sr, dtype=np.float64)
    for _ in range(4):
        player.play_segment(audio, sr, 0, sr // 4)
    # 每次都正常结束, 只有一个 sink 生命周期, 无残留播放状态
    assert not player.is_playing()


def test_stop_resets_state(qapp, monkeypatch):
    import audio_repair.player as mod

    class SlowSink(FakeSink):
        def processedUSecs(self):
            return 0  # 永不播完, 模拟播放中途

    monkeypatch.setattr(mod, "QAudioSink", SlowSink)
    player = AudioPlayer()
    events = []
    player.stateChanged.connect(lambda playing: events.append(playing))
    audio = np.zeros(8000, dtype=np.float64)
    player.play_segment(audio, 8000, 0, 4000)
    assert player.is_playing()
    player.stop()
    assert not player.is_playing()
    assert events == [True, False]


def test_empty_segment_is_noop(qapp, monkeypatch):
    import audio_repair.player as mod
    monkeypatch.setattr(mod, "QAudioSink", FakeSink)
    player = AudioPlayer()
    audio = np.zeros(100, dtype=np.float64)
    player.play_segment(audio, 8000, 50, 50)
    assert not player.is_playing()
    assert player.end_time == 0.0
