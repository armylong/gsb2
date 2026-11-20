"""试听引擎 (可测试、可无人值守运行).

``AudioEngine`` 只负责"提供片段"与"记录播放状态"; 真正出声由
``QtAudioSink`` 完成。测试里可以注入 ``NullSink`` 来验证失效逻辑。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

from .align import AlignmentResult
from .playback import PLAYBACK_SR, PlaybackClip, PlaybackError, build_ab_clip


class Sink(Protocol):
    """播放后端接口。"""

    def play(self, clip: PlaybackClip) -> None: ...

    def stop(self) -> None: ...

    def is_playing(self) -> bool: ...


class NullSink:
    """不出声的后端, 记录调用便于测试。"""

    def __init__(self) -> None:
        self.played: list[PlaybackClip] = []
        self.stop_count = 0

    def play(self, clip: PlaybackClip) -> None:
        self.played.append(clip)

    def stop(self) -> None:
        self.stop_count += 1

    def is_playing(self) -> bool:
        return False


@dataclass
class PlaybackState:
    token: int = 0
    active_clip: PlaybackClip | None = None
    invalidated_reason: str = ""
    history: list[int] = field(default_factory=list)


class AudioEngine:
    """管理"当前有效的一次试听"。

    任何会让旧片段失效的操作 (切换区间/停止/重新分析/锚点变化) 都必须
    先 ``invalidate``, 再 ``stop``; ``play`` 只接受与当前状态一致的 token。
    """

    def __init__(self, sink: Sink | None = None) -> None:
        self.sink = sink if sink is not None else NullSink()
        self.state = PlaybackState()
        self._result: AlignmentResult | None = None
        self._generation = 0
        self._anchors_sig = ""

    # ---- 生命周期 ---------------------------------------------------------

    def set_result(self, result: AlignmentResult | None, anchors_sig: str = "") -> None:
        """载入/刷新分析结果。旧结果的一切试听都立即失效。"""

        self.invalidate("重新分析/载入新结果")
        self._result = result
        self._generation += 1
        self._anchors_sig = anchors_sig

    def invalidate(self, reason: str) -> int:
        """使当前片段失效; 返回新的 token。"""

        self.sink.stop()
        self.state.token += 1
        self.state.active_clip = None
        self.state.invalidated_reason = reason
        return self.state.token

    def stop(self) -> None:
        self.invalidate("停止播放")

    # ---- 试听 -------------------------------------------------------------

    def play(self, start_s: float, end_s: float, mode: str = "ab") -> PlaybackClip:
        if self._result is None:
            raise PlaybackError("尚未有对齐结果")
        # 上一个片段先失效, 再构建新片段
        token = self.invalidate("切换试听区间/模式")
        clip = build_ab_clip(self._result, start_s, end_s, token, mode=mode)
        if token != self.state.token:
            raise PlaybackError("试听参数已失效")
        self.state.active_clip = clip
        self.state.history.append(token)
        self.sink.play(clip)
        return clip

    def play_with(self, clip: PlaybackClip) -> PlaybackClip:
        """播放一个已经构建好的片段 (供界面复用同一次渲染)。"""

        if self._result is None:
            raise PlaybackError("尚未有对齐结果")
        if clip.token != self.state.token:
            raise PlaybackError("该试听片段已失效, 请重新选择区间")
        self.sink.stop()
        self.sink.play(clip)
        return clip

    @property
    def current(self) -> PlaybackClip | None:
        """只有在 token 与当前状态一致时才返回片段。"""

        clip = self.state.active_clip
        if clip is None or clip.token != self.state.token:
            return None
        return clip

    def is_current(self, clip: PlaybackClip | None) -> bool:
        return clip is not None and clip.token == self.state.token and clip is self.state.active_clip

    def anchors_signature(self) -> str:
        return self._anchors_sig

    def update_anchors_signature(self, sig: str) -> None:
        """锚点变化后旧试听必须失效。"""

        if sig != self._anchors_sig:
            self._anchors_sig = sig
            self.invalidate("人工锚点已修改")


class MixingNotSupported(RuntimeError):
    pass


def reject_mixing(*_args, **_kwargs):
    """显式拒绝混音/音量包络类请求 (需求要求不扩展为混音软件)。"""

    raise MixingNotSupported("本工具不提供混音、增益或音量包络功能")


def make_default_sink() -> Sink:
    """选择播放后端: 有 QtMultimedia 时用真实播放, 否则退化为静默后端。

    静默后端仍会完整走过"片段构建/失效"逻辑, 便于测试与无音频设备环境。
    """

    try:
        return QtAudioSink()
    except Exception:  # noqa: BLE001 - 缺音频设备/插件时不应阻止程序启动
        return NullSink()


class QtAudioSink:
    """基于 QtMultimedia 的播放后端 (延迟导入, 便于无界面环境测试)。"""

    def __init__(self) -> None:
        from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QTimer
        from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices

        self._QBuffer = QBuffer
        self._QByteArray = QByteArray
        self._QIODevice = QIODevice
        self._QTimer = QTimer
        device = QMediaDevices.defaultAudioOutput()
        fmt = QAudioFormat()
        fmt.setSampleRate(PLAYBACK_SR)
        fmt.setChannelCount(2)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Float)
        if not device.isFormatSupported(fmt):
            fmt = device.preferredFormat()
            fmt.setChannelCount(min(2, fmt.channelCount()))
        self._format = fmt
        self._sink = QAudioSink(device, fmt)
        self._sink.setBufferSize(int(PLAYBACK_SR * 0.25) * fmt.channelCount() * 4)
        self._buffer = None
        self._playing = False
        self._stop_timer = QTimer()
        self._stop_timer.setSingleShot(True)
        self._stop_timer.timeout.connect(self._on_finished)

    def play(self, clip: PlaybackClip) -> None:
        self.stop()
        data = np.ascontiguousarray(clip.stereo, dtype="<f4")
        raw = data.tobytes()
        qbytes = self._QByteArray(raw)
        buf = self._QBuffer()
        buf.setData(qbytes)
        buf.open(self._QIODevice.OpenModeFlag.ReadOnly)
        self._buffer = buf
        self._playing = True
        self._sink.start(buf)
        self._stop_timer.start(int(clip.duration * 1000) + 120)

    def stop(self) -> None:
        self._stop_timer.stop()
        try:
            self._sink.stop()
        except RuntimeError:
            pass
        if self._buffer is not None:
            self._buffer.close()
            self._buffer = None
        self._playing = False

    def _on_finished(self) -> None:
        self.stop()

    def is_playing(self) -> bool:
        return self._playing
