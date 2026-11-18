"""WAV 读取、导出与回读核对。"""

from __future__ import annotations

import os

import numpy as np
import soundfile as sf

from .dsp import EPS_LINEAR, ProcessResult, amp_to_db

MAX_DURATION_S = 12.0
SUPPORTED_FS = (44100, 48000)
# 16-bit PCM 量化的峰值核对容差
PEAK_TOL_DB = 0.5


class AudioLoadError(ValueError):
    pass


class ClippingError(RuntimeError):
    """补偿后超幅：阻止导出，避免静默削波。"""


def load_wav(path: str) -> tuple[np.ndarray, int]:
    """读取 wav，返回 (float64 数组, fs)。

    单声道形状 (n,)，立体声 (n, 2)。校验格式、采样率、长度、声道数。
    """
    if not os.path.isfile(path):
        raise AudioLoadError(f"文件不存在：{path}")
    if os.path.splitext(path)[1].lower() != ".wav":
        raise AudioLoadError("仅支持 .wav 文件")

    info = sf.info(path)
    if info.samplerate not in SUPPORTED_FS:
        raise AudioLoadError(
            f"仅支持 44.1kHz / 48kHz，文件为 {info.samplerate} Hz")
    if info.channels not in (1, 2):
        raise AudioLoadError(
            f"仅支持单声道或立体声，文件为 {info.channels} 声道")
    if info.frames > MAX_DURATION_S * info.samplerate:
        raise AudioLoadError(
            f"音频长度 {info.frames / info.samplerate:.2f}s 超过 "
            f"{MAX_DURATION_S:.0f} 秒限制")

    data, fs = sf.read(path, dtype="float64", always_2d=False)
    if data.ndim == 2:
        data = np.ascontiguousarray(data)
    return data, fs


def export_wav(path: str, result: ProcessResult) -> str:
    """导出当前处理结果为 16-bit PCM wav。

    超幅（补偿后峰值 > 0 dBFS）时抛 ClippingError 阻止导出，
    绝不静默削波。
    """
    if result.clipped:
        raise ClippingError(
            f"补偿后峰值 {result.output_peak_db:+.2f} dBFS 超过 0 dBFS，"
            "已阻止导出；请降低补偿增益。")
    y = np.clip(result.output, -1.0, 1.0)
    sf.write(path, y, result.fs, subtype="PCM_16")
    return path


def readback_verify(path: str, result: ProcessResult) -> dict:
    """回读导出文件并核对长度、峰值、声道关系。"""
    data, fs = sf.read(path, dtype="float64", always_2d=False)

    checks: dict = {"path": path, "fs_match": fs == result.fs}
    checks["length_match"] = data.shape[0] == result.n
    checks["channels_match"] = (
        (data.ndim == 1 and result.channels == 1)
        or (data.ndim == 2 and data.shape[1] == result.channels))

    rb_peak = float(np.max(np.abs(data))) if data.size else 0.0
    rb_peak_db = float(amp_to_db(np.array(max(rb_peak, EPS_LINEAR))))
    checks["readback_peak_db"] = rb_peak_db
    checks["expected_peak_db"] = result.output_peak_db
    checks["peak_within_tol"] = (
        abs(rb_peak_db - result.output_peak_db) <= PEAK_TOL_DB)

    # 声道关系：立体声时每个非零样本 L/R 比值应与处理前一致
    # （link 增益对两侧同比例，声像不漂移）
    if result.channels == 2:
        src = result.input
        mask = np.min(np.abs(src), axis=1) > EPS_LINEAR
        if np.count_nonzero(mask) > 0:
            ratio_in = src[mask, 0] / src[mask, 1]
            ratio_out = data[mask, 0] / data[mask, 1]
            rel_err = np.median(
                np.abs(ratio_out - ratio_in) / np.abs(ratio_in))
            checks["stereo_ratio_max_rel_err"] = float(rel_err)
            checks["stereo_balance_preserved"] = rel_err < 2e-4
        else:
            checks["stereo_balance_preserved"] = True
    else:
        checks["stereo_balance_preserved"] = None

    checks["ok"] = bool(
        checks["fs_match"] and checks["length_match"]
        and checks["channels_match"] and checks["peak_within_tol"]
        and checks["stereo_balance_preserved"] in (True, None))
    return checks
