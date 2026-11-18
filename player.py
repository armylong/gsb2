"""实时播放: sounddevice 回调流, 支持循环区间、定位、暂停, 并在
寻址/暂停/循环回卷时重置滤波状态, 避免旧位置的滤波余音串入。"""
from __future__ import annotations

import threading

import numpy as np
import sounddevice as sd

from eq_dsp import EQChain

BLOCKSIZE = 512


class Player:
    def __init__(self):
        self._lock = threading.Lock()
        self._stream: sd.OutputStream | None = None
        self._data: np.ndarray | None = None  # (n, ch) float32
        self._sr = 0
        self._pos = 0  # 帧
        self._playing = False
        self._loop: tuple[int, int] | None = None  # (start_frame, end_frame)
        self._need_reset = False
        self.chain: EQChain | None = None
        self.peak = 0.0       # 处理后峰值 (线性)
        self.clipped = False  # 超幅锁存

    # ---- 装载 ----
    def load(self, data: np.ndarray, sr: int):
        self.stop()
        d = np.asarray(data, dtype=np.float32)
        if d.ndim == 1:
            d = d[:, None]
        with self._lock:
            self._data = np.ascontiguousarray(d)
            self._sr = sr
            self._pos = 0
            self._loop = None
            self.chain = EQChain(d.shape[1], sr)
            self.peak = 0.0
            self.clipped = False
            self._need_reset = False

    @property
    def loaded(self) -> bool:
        return self._data is not None

    @property
    def samplerate(self) -> int:
        return self._sr

    @property
    def duration(self) -> float:
        return 0.0 if self._data is None else len(self._data) / self._sr

    @property
    def n_channels(self) -> int:
        return 0 if self._data is None else self._data.shape[1]

    # ---- 传输控制 ----
    def play(self):
        with self._lock:
            if self._data is None:
                return
            if self._stream is None:
                self._stream = sd.OutputStream(
                    samplerate=self._sr,
                    channels=self._data.shape[1],
                    blocksize=BLOCKSIZE,
                    latency="low",
                    dtype="float32",
                    callback=self._callback,
                )
                self._stream.start()
            elif not self._stream.active:
                self._stream.start()
            self._playing = True

    def pause(self):
        with self._lock:
            self._playing = False
            self._need_reset = True  # 恢复播放时不带旧滤波余音

    def stop(self):
        with self._lock:
            self._playing = False
            self._pos = 0
            self._need_reset = True
            if self._stream is not None:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass
                self._stream = None

    def seek(self, seconds: float):
        with self._lock:
            if self._data is None:
                return
            self._pos = int(min(max(seconds, 0.0), self.duration) * self._sr)
            self._need_reset = True

    def set_loop(self, start_s: float, end_s: float):
        with self._lock:
            if self._data is None:
                return
            a = int(min(start_s, end_s) * self._sr)
            b = int(max(start_s, end_s) * self._sr)
            b = min(b, len(self._data))
            if b - a < self._sr // 100:  # 小于 10ms 不循环
                self._loop = None
            else:
                self._loop = (a, b)

    def clear_loop(self):
        with self._lock:
            self._loop = None

    @property
    def loop(self):
        with self._lock:
            return self._loop

    @property
    def playing(self) -> bool:
        return self._playing

    def position(self) -> float:
        with self._lock:
            return self._pos / self._sr if self._sr else 0.0

    def reset_peak(self):
        with self._lock:
            self.peak = 0.0
            self.clipped = False

    def close(self):
        self.stop()

    # ---- 音频回调 (实时线程) ----
    def _callback(self, outdata, frames, time_info, status):
        with self._lock:
            if not self._playing or self._data is None or self.chain is None:
                outdata[:] = 0
                return
            if self._need_reset:
                self.chain.reset()
                self._need_reset = False
            data = self._data
            n_total = len(data)
            loop = self._loop
            out = np.zeros((frames, data.shape[1]), dtype=np.float32)
            filled = 0
            pos = self._pos
            guard = 0
            while filled < frames and guard < 8:
                guard += 1
                end_limit = loop[1] if loop else n_total
                if pos >= end_limit:
                    # 到末尾或循环点: 回卷并清除滤波余音
                    pos = loop[0] if loop else 0
                    self.chain.reset()
                    if not loop:
                        self._playing = False
                        break
                    continue
                n = min(frames - filled, end_limit - pos)
                out[filled:filled + n] = data[pos:pos + n]
                pos += n
                filled += n
            self._pos = pos
            processed = self.chain.process(out)
            outdata[:] = processed
            p = float(np.max(np.abs(processed))) if processed.size else 0.0
            if p > self.peak:
                self.peak = p
            if p >= 1.0:
                self.clipped = True
