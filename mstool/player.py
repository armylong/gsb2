"""实时播放器（sounddevice 回调模式）。

设计要点：
- 音频流常驻，回调按下一块请求逐块从原始 LR 做中侧处理，
  播放中拖动滑块时增益在块内线性插值（ramp），不产生拉链噪声/爆音。
- 开始、跳转、暂停恢复、模式切换都触发一次毫秒级淡入包络，
  掩盖信号不连续点。
- 播放位置就是回调实际消费的帧下标，界面定时器读同一个值驱动指针，
  保证暂停、停止、区间跳转后声音与波形指针一致。
"""

from __future__ import annotations

import threading

import numpy as np
import sounddevice as sd

from .audio_engine import (
    ALL_MODES,
    GAIN_MAX,
    GAIN_MIN,
    MODE_MID,
    MODE_SIDE,
    Params,
)

FADE_SEC = 0.01          # 跳转/模式切换淡入 10ms
RAMP_BLOCK_SEC = 0.02    # 增益变化参考斜坡时长


class PlayerError(Exception):
    """音频设备无法打开或播放失败。"""


class AudioPlayer:
    def __init__(self, samples: np.ndarray, samplerate: int):
        self._src = np.ascontiguousarray(samples, dtype=np.float64)
        self._sr = int(samplerate)
        self._n = self._src.shape[0]
        self._lock = threading.Lock()

        self._playing = False
        self._pos = 0                       # 下一个待输出帧
        self._region: tuple[int, int] | None = None
        self._loop = False

        self._mid_gain = 1.0
        self._side_gain = 1.0
        self._attenuation = 1.0
        self._mode = "stereo"

        # 斜坡锚点：起始增益 + 斜坡总样本数。整条斜坡用固定全局斜率
        # (目标-锚点)/总样本，按已走样本取值，块边界天然严格连续
        self._ramp_mid_anchor = 1.0
        self._ramp_side_anchor = 1.0
        self._ramp_att_anchor = 1.0
        self._ramp_elapsed = 0          # 斜坡已走样本数
        self._fade_total = max(1, int(self._sr * FADE_SEC))
        self._ramp_total = max(1, int(self._sr * RAMP_BLOCK_SEC))
        self._fade_remaining = 0

        self._stream: sd.OutputStream | None = None

    # ------------------------------------------------------------ 生命周期

    def _ensure_stream(self) -> None:
        if self._stream is not None:
            return
        try:
            self._stream = sd.OutputStream(
                samplerate=self._sr,
                channels=2,
                dtype="float32",
                blocksize=512,
                callback=self._callback,
            )
            self._stream.start()
        except sd.PortAudioError as exc:
            self._stream = None
            raise PlayerError(f"无法打开音频设备：{exc}") from exc

    def close(self) -> None:
        with self._lock:
            self._playing = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            finally:
                self._stream = None

    # ------------------------------------------------------------ 参数推送

    def set_gains(self, mid_gain: float, side_gain: float,
                  attenuation: float) -> None:
        """中/侧增益与统一保护衰减（由主窗口按当前参数算好推入）。"""
        mid_gain = float(np.clip(mid_gain, GAIN_MIN, GAIN_MAX))
        side_gain = float(np.clip(side_gain, GAIN_MIN, GAIN_MAX))
        with self._lock:
            self._start_ramp_locked(mid_gain, side_gain,
                                    float(attenuation))

    def _start_ramp_locked(self, mid_gain: float, side_gain: float,
                           attenuation: float) -> None:
        """从当前实际值启动一条 RAMP_BLOCK_SEC 的斜坡（持锁调用）。"""
        cur_m, cur_s, cur_a = self._current_ramp_gains_locked()
        self._ramp_mid_anchor = cur_m
        self._ramp_side_anchor = cur_s
        self._ramp_att_anchor = cur_a
        self._mid_gain = mid_gain
        self._side_gain = side_gain
        self._attenuation = attenuation
        if (cur_m != mid_gain or cur_s != side_gain
                or cur_a != attenuation):
            self._ramp_elapsed = 0
        else:
            self._ramp_elapsed = self._ramp_total

    def _current_ramp_gains_locked(self) -> tuple[float, float, float]:
        """斜坡在当前时刻的瞬时增益（持锁调用）。"""
        if self._ramp_elapsed >= self._ramp_total:
            return self._mid_gain, self._side_gain, self._attenuation
        frac = self._ramp_elapsed / self._ramp_total
        m = self._ramp_mid_anchor + (
            self._mid_gain - self._ramp_mid_anchor) * frac
        s = self._ramp_side_anchor + (
            self._side_gain - self._ramp_side_anchor) * frac
        a = self._ramp_att_anchor + (
            self._attenuation - self._ramp_att_anchor) * frac
        return m, s, a

    def set_mode(self, mode: str) -> None:
        if mode not in ALL_MODES:
            raise ValueError(f"未知监听模式：{mode}")
        with self._lock:
            if mode == self._mode:
                return
            self._mode = mode
            # 模式切换瞬间信号内容会变，用淡入掩盖交界点
            self._fade_remaining = self._fade_total

    def set_region(self, start: int | None, end: int | None,
                   loop: bool = False) -> None:
        with self._lock:
            if start is None or end is None or end <= start:
                self._region = None
            else:
                self._region = (int(start), int(end))
            self._loop = bool(loop)

    def sync_params(self, params: Params, attenuation: float) -> None:
        with self._lock:
            self._start_ramp_locked(
                float(np.clip(params.mid_gain, GAIN_MIN, GAIN_MAX)),
                float(np.clip(params.side_gain, GAIN_MIN, GAIN_MAX)),
                float(attenuation))
            if params.mode != self._mode:
                self._mode = params.mode
                self._fade_remaining = self._fade_total

    # ------------------------------------------------------------ 传输控制

    def play(self) -> None:
        self._ensure_stream()
        with self._lock:
            region_end = self._region[1] if self._region else self._n
            if self._pos >= region_end:
                # 已到区间/文件尾则从头播
                self._pos = self._region[0] if self._region else 0
            self._playing = True
            # 播放开始即对齐当前目标值，淡入包络负责消除起点不连续
            self._ramp_mid_anchor = self._mid_gain
            self._ramp_side_anchor = self._side_gain
            self._ramp_att_anchor = self._attenuation
            self._ramp_elapsed = self._ramp_total
            self._fade_remaining = self._fade_total

    def pause(self) -> None:
        with self._lock:
            self._playing = False
            self._fade_remaining = 0

    def stop(self) -> None:
        with self._lock:
            self._playing = False
            self._pos = self._region[0] if self._region else 0
            self._fade_remaining = 0

    def seek(self, frame: int) -> None:
        frame = int(np.clip(frame, 0, self._n))
        with self._lock:
            self._pos = frame
            if self._playing:
                self._fade_remaining = self._fade_total

    @property
    def playing(self) -> bool:
        return self._playing

    def position(self) -> int:
        return self._pos

    # ------------------------------------------------------------ 回调

    def _callback(self, outdata: np.ndarray, frames: int,
                  time_info, status) -> None:  # noqa: ANN001
        with self._lock:
            if not self._playing:
                outdata.fill(0)
                # 静默期把斜坡锚点对齐当前目标，恢复播放时不会带旧值
                self._ramp_mid_anchor = self._mid_gain
                self._ramp_side_anchor = self._side_gain
                self._ramp_att_anchor = self._attenuation
                self._ramp_elapsed = self._ramp_total
                return

            pos = self._pos
            region = self._region
            loop = self._loop
            mode = self._mode
            target_mid = self._mid_gain
            target_side = self._side_gain
            target_att = self._attenuation
            anchor_mid = self._ramp_mid_anchor
            anchor_side = self._ramp_side_anchor
            anchor_att = self._ramp_att_anchor
            elapsed = self._ramp_elapsed
            fade_remaining = self._fade_remaining
            fade_total = self._fade_total

        end_limit = region[1] if region else self._n
        take = min(frames, end_limit - pos)
        if take <= 0:
            if loop and region is not None:
                with self._lock:
                    self._pos = region[0]
                    self._fade_remaining = fade_total
                outdata.fill(0)
                return
            with self._lock:
                self._playing = False
            outdata.fill(0)
            return

        block = self._src[pos:pos + take]
        left, right = block[:, 0], block[:, 1]
        mid = (left + right) * 0.5
        side = (left - right) * 0.5

        idx = np.arange(take, dtype=np.float64)
        # 固定全局斜率的斜坡。本块第 i 个样本（i 从 0 起）对应全局位置
        # elapsed+i+1；上一块末样本与本块首样本取同一全局位置，增益严格
        # 相等，整条斜坡连续无爆音，斜坡在 RAMP_BLOCK_SEC 处到达目标
        if elapsed < self._ramp_total:
            frac = np.minimum(
                (elapsed + idx + 1.0) / self._ramp_total, 1.0)
            gm = anchor_mid + (target_mid - anchor_mid) * frac
            gs = anchor_side + (target_side - anchor_side) * frac
            ga = anchor_att + (target_att - anchor_att) * frac
            elapsed = min(self._ramp_total, elapsed + take)
        else:
            gm = np.full(take, target_mid)
            gs = np.full(take, target_side)
            ga = np.full(take, target_att)

        mg = mid * gm
        sg = side * gs
        if mode == MODE_MID:
            buf = np.column_stack((mg, mg))
        elif mode == MODE_SIDE:
            buf = np.column_stack((sg, sg))
        else:
            buf = np.column_stack((mg + sg, mg - sg))
        buf = buf * ga[:, np.newaxis]

        # 淡入包络（开始/跳转/模式切换）
        if fade_remaining > 0:
            f = min(fade_remaining, take)
            start_level = 1.0 - fade_remaining / fade_total
            env = start_level + (np.arange(f, dtype=np.float64) + 1.0) / fade_total
            env = np.minimum(env, 1.0)
            buf[:f] *= env[:, np.newaxis]
            fade_remaining -= f

        out = np.zeros((frames, 2), dtype=np.float32)
        out[:take] = buf.astype(np.float32)

        new_pos = pos + take
        reached_end = new_pos >= end_limit
        stopped = False
        if take < frames or (reached_end and not loop):
            if loop and region is not None:
                new_pos = region[0]
                fade_remaining = fade_total
            else:
                stopped = True

        with self._lock:
            self._pos = new_pos
            self._ramp_elapsed = elapsed
            self._fade_remaining = max(0, fade_remaining)
            if stopped:
                self._playing = False
        outdata[:] = out


def render_offline_block(src: np.ndarray, start: int, frames: int,
                         mode: str, mid_gain: float, side_gain: float,
                         attenuation: float) -> np.ndarray:
    """与回调相同的单块处理逻辑（无斜坡版本），供无设备环境测试。"""
    block = src[start:start + frames]
    mid, side = (block[:, 0] + block[:, 1]) * 0.5, (block[:, 0] - block[:, 1]) * 0.5
    mg, sg = mid * mid_gain, side * side_gain
    if mode == MODE_MID:
        buf = np.column_stack((mg, mg))
    elif mode == MODE_SIDE:
        buf = np.column_stack((sg, sg))
    else:
        buf = np.column_stack((mg + sg, mg - sg))
    return buf * attenuation
