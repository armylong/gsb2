"""短区间 A/B 对照试听.

规则 (来自需求):
    * 左右声道对照: 左声道 = 参考录音, 右声道 = 对齐结果, 两者取自
      **同一个参考时间区间**。
    * 播放内容在开始播放时一次性取样并冻结; 切换区间、停止、重新分析
      都会让当前播放失效, 不会在之后"接着播上一次的结果"。
    * 没有音量包络/混音等处理; 只做必要的短交叉淡化 (5 ms) 防止爆音,
      且该淡化只作用于播放副本, 不写入任何导出文件。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import soundfile as sf

from .align import AlignmentResult
from .render import render_reference_compare

PLAYBACK_SR = 48_000
MIN_WINDOW_S = 0.20
MAX_WINDOW_S = 30.0
EDGE_FADE_S = 0.005


class PlaybackError(RuntimeError):
    """无法开始试听。"""


PLAYBACK_MODES = ("ab", "reference", "aligned")


@dataclass(frozen=True)
class PlaybackClip:
    token: int
    start_s: float
    end_s: float
    stereo: np.ndarray  # (frames, 2)
    sample_rate: int
    mode: str = "ab"  # "ab" | "reference" | "aligned"

    @property
    def duration(self) -> float:
        return len(self.stereo) / float(self.sample_rate)

    @property
    def label(self) -> str:
        return {
            "ab": "左右对照 (左=参考, 右=对齐结果)",
            "reference": "仅参考录音",
            "aligned": "仅对齐结果 (缺失区间静音)",
        }.get(self.mode, self.mode)


def build_ab_clip(
    result: AlignmentResult,
    start_s: float,
    end_s: float,
    token: int,
    sample_rate: int = PLAYBACK_SR,
    mode: str = "ab",
) -> PlaybackClip:
    """构建试听片段。

    mode:
        "ab"         左=参考, 右=对齐结果 (同一参考时间区间)
        "reference"  仅参考录音 (双声道相同)
        "aligned"    仅对齐结果 (双声道相同; 缺失区间为静音)

    三种模式都在同一参考时间区间取样, 可直接来回切换比较。
    """

    if mode not in PLAYBACK_MODES:
        raise PlaybackError(f"未知试听模式: {mode}")
    if not np.isfinite(start_s) or not np.isfinite(end_s):
        raise PlaybackError("试听区间无效")
    if end_s - start_s < MIN_WINDOW_S:
        raise PlaybackError(f"试听区间至少 {MIN_WINDOW_S:.2f} 秒")
    if end_s - start_s > MAX_WINDOW_S:
        raise PlaybackError(f"试听区间最多 {MAX_WINDOW_S:.0f} 秒")
    if start_s < 0 or end_s > result.ref_duration + 1e-6:
        raise PlaybackError(
            f"试听区间超出参考录音范围 0-{result.ref_duration:.3f}s"
        )
    ref, sr = render_reference_compare(result, "reference", start_s, end_s, sample_rate)
    aligned, _ = render_reference_compare(result, "aligned", start_s, end_s, sample_rate)
    stereo = np.zeros((ref.shape[0], 2), dtype=np.float32)
    if mode == "reference":
        stereo[:, 0] = ref[:, 0]
        stereo[:, 1] = ref[:, 0]
    elif mode == "aligned":
        stereo[:, 0] = aligned[:, 0]
        stereo[:, 1] = aligned[:, 0]
    else:
        stereo[:, 0] = ref[:, 0]  # 参考录音取左声道 (单声道则同一信号)
        stereo[:, 1] = aligned[:, 0] if aligned.shape[1] else 0.0
    stereo = _edge_fade(stereo, sr)
    return PlaybackClip(
        token=token, start_s=start_s, end_s=end_s, stereo=stereo,
        sample_rate=sr, mode=mode,
    )


def _edge_fade(stereo: np.ndarray, sr: int) -> np.ndarray:
    n = len(stereo)
    fade = min(int(EDGE_FADE_S * sr), n // 2)
    if fade <= 1:
        return stereo
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    out = stereo.copy()
    out[:fade] *= ramp[:, None]
    out[-fade:] *= ramp[::-1, None]
    return out


def write_preview_wav(clip: PlaybackClip, path) -> None:
    """把试听片段写成 wav (仅用于离线核对, 不参与导出流程)。"""

    sf.write(str(path), clip.stereo, clip.sample_rate, subtype="FLOAT", format="WAV")
