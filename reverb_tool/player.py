"""基于 sounddevice 的单次播放游标。

要点：
* 播放内容永远是一份**不可变快照**（``np.ndarray`` + 采样率）。
* 拖动位置 / 换参数 / 停止时先 ``stop()``，声卡队列里不会留下上一段。
* 播放头位置由声卡回调实际消费的帧数推算，与波形视图使用同一个输出时间轴。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np

try:
    import sounddevice as sd
except OSError as exc:  # pragma: no cover - 没有 PortAudio 的机器
    sd = None  # type: ignore[assignment]
    _SD_IMPORT_ERROR = exc
else:
    _SD_IMPORT_ERROR = None


class PlaybackUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Clip:
    """一次播放的不可变快照。samples 形状 (frames, 2)，float32。"""

    samples: np.ndarray
    sample_rate: int
    start_frame: int  # 在输出时间轴上的起点
    total_frames: int  # 调用方视角（整段结果）的总长

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def start_time_s(self) -> float:
        return self.start_frame / self.sample_rate

    @property
    def duration_s(self) -> float:
        return self.frames / self.sample_rate


def slice_clip(
    samples: np.ndarray, sample_rate: int, start_frame: int, end_frame: int
) -> Clip:
    """把整体输出的一段时间区间切成播放快照。"""
    array = np.asarray(samples)
    if array.ndim == 1:
        array = array[:, None]
    total = int(array.shape[0])
    start = int(np.clip(start_frame, 0, total))
    end = int(np.clip(end_frame, start, total))
    data = np.ascontiguousarray(array[start:end], dtype=np.float32)
    return Clip(samples=data, sample_rate=int(sample_rate), start_frame=start, total_frames=total)


class Player:
    """同一时刻只允许一个声音。线程安全的停止语义：stop() 后立即静音。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._stream = None
        self._clip: Clip | None = None
        self._cursor = 0
        self._finished = False
        self._stopped = False
        self._generation = 0
        self._last_device: int | None = None

    # ---------- 状态 ----------
    @property
    def active(self) -> bool:
        # 用内部游标判断是否"还有声音在放"，而不是依赖声卡 stream 对象；
        # 这样停止/播完/被替换都会立刻反映为 False。
        clip = self._clip
        return clip is not None and not self._stopped and self._cursor < clip.frames

    @property
    def clip(self) -> Clip | None:
        return self._clip

    def position_frame(self) -> int:
        """当前播放位置（输出时间轴帧号）。未播放时返回 0。"""
        clip = self._clip
        if clip is None:
            return 0
        return int(min(clip.total_frames, clip.start_frame + self._cursor))

    def position_s(self) -> float:
        clip = self._clip
        if clip is None:
            return 0.0
        return self.position_frame() / clip.sample_rate

    def finished(self) -> bool:
        return self._finished

    # ---------- 控制 ----------
    def stop(self) -> None:
        with self._lock:
            self._generation += 1
            stream, self._stream = self._stream, None
            self._finished = False
            self._stopped = True
        # abort() 会丢弃设备队列中尚未播出的帧，避免残留上一段声音。
        if stream is not None:
            try:
                stream.abort()
                stream.close()
            except Exception:
                pass

    def play(self, clip: Clip, device: int | None = None) -> None:
        if sd is None:
            raise PlaybackUnavailable(f"sounddevice 不可用: {_SD_IMPORT_ERROR}")
        if clip.frames <= 0:
            raise ValueError("播放区间为空")
        self.stop()
        with self._lock:
            self._clip = clip
            self._cursor = 0
            self._finished = False
            self._stopped = False
            self._generation += 1
            generation = self._generation
            self._last_device = device

        def callback(outdata, frames, time_info, status) -> None:
            with self._lock:
                if generation != self._generation or self._stream is None:
                    outdata[:] = 0
                    raise sd.CallbackAbort
                remaining = clip.frames - self._cursor
                if remaining <= 0:
                    outdata[:] = 0
                    self._finished = True
                    raise sd.CallbackStop
                count = min(frames, remaining)
                block = clip.samples[self._cursor : self._cursor + count]
                outdata[:count] = block
                if count < frames:
                    outdata[count:] = 0
                    self._cursor = clip.frames
                    self._finished = True
                    raise sd.CallbackStop
                self._cursor += count

        stream = sd.OutputStream(
            samplerate=clip.sample_rate,
            channels=clip.samples.shape[1],
            dtype="float32",
            callback=callback,
            device=device,
            latency="low",
        )
        with self._lock:
            if generation != self._generation:  # 竞态：构造期间被 stop
                try:
                    stream.close()
                except Exception:
                    pass
                return
            self._stream = stream
        try:
            stream.start()
        except Exception:
            self.stop()
            raise

    def wait_finished(self, timeout: float | None = None) -> bool:
        import time as _time

        deadline = None if timeout is None else _time.monotonic() + timeout
        while self.active:
            if deadline is not None and _time.monotonic() > deadline:
                return False
            _time.sleep(0.02)
        return True

    def device_name(self) -> str:
        if sd is None:
            return "无音频输出"
        try:
            info = sd.query_devices(self._last_device, kind="output")
            return str(info["name"])
        except Exception:
            return "默认输出设备"
