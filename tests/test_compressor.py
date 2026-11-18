"""DSP 与导出核对测试（无头，不依赖 GUI）。

测量窗口约定：稳态电平取各段最后 20% 样本的峰值中位数；
起音/恢复按已声明的一阶 RC 口径（1/e ≈ 36.8% 差距）验证。
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from compressor.audio_io import (
    ClippingError, export_wav, readback_verify)
from compressor.dsp import (
    CompressorParams, db_to_amp, process, time_constant_coeff)
from compressor.synth import FS, make_sample


# ---------- 小工具 ----------

def steady_level_db(seg: np.ndarray) -> float:
    """稳态电平（dBFS）：取段尾 20% 窗口的 RMS。

    包络按逐采样峰值检测，稳态正弦的峰值会稳定在信号峰值；
    RMS 与峰值对正弦相差固定 3.01 dB，比较时同口径换算即可。
    """
    k = max(1, int(seg.shape[0] * 0.2))
    tail = seg[-k:]
    rms = float(np.sqrt(np.mean(np.asarray(tail, dtype=np.float64) ** 2)))
    return float(20 * np.log10(max(rms, 1e-12)))


PEAK_TO_RMS_DB = 20 * np.log10(np.sqrt(2) / 2)  # 正弦峰值 - RMS ≈ 3.01 dB


def tone(fs: int, dur: float, level_db: float, freq: float = 300.0,
         stereo: bool = False, lr_db: float | None = None) -> np.ndarray:
    n = int(round(dur * fs))
    t = np.arange(n) / fs
    mono = db_to_amp(np.array(level_db)) * np.sin(2 * np.pi * freq * t)
    if not stereo:
        return mono
    right = (mono if lr_db is None
             else db_to_amp(np.array(level_db + lr_db))
             * np.sin(2 * np.pi * freq * t))
    return np.stack([mono, right], axis=1)


def silence(fs: int, dur: float, stereo: bool = False) -> np.ndarray:
    n = int(round(dur * fs))
    return np.zeros((n, 2) if stereo else n)


def concat(*parts: np.ndarray) -> np.ndarray:
    return np.concatenate(parts, axis=0)


# ---------- 1. ratio=1 不压缩 ----------

def test_ratio_one_no_compression():
    fs = FS
    x = concat(silence(fs, 0.3), tone(fs, 2.0, -10.0),
               tone(fs, 2.0, -30.0))
    p = CompressorParams(threshold_db=-20.0, ratio=1.0,
                         attack_ms=5.0, release_ms=50.0, makeup_db=0.0)
    r = process(x, fs, p)
    assert np.all(r.gain_reduction_db == 0.0)
    assert np.allclose(r.output, x, atol=1e-12)
    assert not r.clipped


# ---------- 2. 阈值以下稳态不压缩 ----------

def test_below_threshold_untouched():
    fs = FS
    x = tone(fs, 3.0, -30.0)
    p = CompressorParams(threshold_db=-18.0, ratio=4.0)
    r = process(x, fs, p)
    assert np.all(r.gain_reduction_db == 0.0)
    assert steady_level_db(r.output) == pytest.approx(
        -30.0 + PEAK_TO_RMS_DB, abs=0.05)


# ---------- 3. 稳态输出电平（硬拐点公式，误差 ≤0.5 dB）----------

@pytest.mark.parametrize("in_db,ratio,thr,makeup", [
    (-12.0, 4.0, -24.0, 0.0),
    (-6.0, 8.0, -18.0, 0.0),
    (-10.0, 2.0, -20.0, 3.0),
])
def test_steady_state_level(in_db, ratio, thr, makeup):
    fs = FS
    # 前置 1 秒稳态，保证包络已收敛
    x = tone(fs, 3.0, in_db)
    p = CompressorParams(threshold_db=thr, ratio=ratio,
                         attack_ms=10.0, release_ms=100.0,
                         makeup_db=makeup)
    r = process(x, fs, p)
    over = in_db - thr
    expected_peak = in_db - over * (1 - 1 / ratio) + makeup
    # 输出峰值 dB -> 稳态 RMS dB
    assert steady_level_db(r.output) == pytest.approx(
        expected_peak + PEAK_TO_RMS_DB, abs=0.5)
    # 衰减量稳态值
    expected_gr = over * (1 - 1 / ratio)
    k = int(0.2 * r.n)
    assert np.median(r.gain_reduction_db[-k:]) == pytest.approx(
        expected_gr, abs=0.5)


# ---------- 4. 立体声 link：左右同比例衰减，声像不漂移 ----------

def test_stereo_linked_same_gain():
    fs = FS
    x = concat(
        tone(fs, 1.0, -30.0, stereo=True, lr_db=-6.0),
        tone(fs, 2.5, -12.0, stereo=True, lr_db=-6.0))
    p = CompressorParams(threshold_db=-20.0, ratio=4.0,
                         attack_ms=10.0, release_ms=100.0)
    r = process(x, fs, p)
    assert r.channels == 2
    # 同一条增益曲线：output / input 左右逐点相同
    lin_gain = db_to_amp(-r.gain_reduction_db + p.makeup_db)
    gl = r.output[:, 0] / np.where(x[:, 0] == 0, np.nan, x[:, 0])
    gr_ = r.output[:, 1] / np.where(x[:, 1] == 0, np.nan, x[:, 1])
    mask = (np.abs(x[:, 0]) > 1e-6) & (np.abs(x[:, 1]) > 1e-6)
    assert np.allclose(gl[mask], lin_gain[mask], rtol=1e-9)
    assert np.allclose(gr_[mask], lin_gain[mask], rtol=1e-9)
    # 左右比值保持
    ratio_in = x[mask, 0] / x[mask, 1]
    ratio_out = r.output[mask, 0] / r.output[mask, 1]
    assert np.allclose(ratio_in, ratio_out, rtol=1e-9)


# ---------- 5. 静音不产生无效数值 ----------

def test_silence_has_no_invalid_values():
    fs = FS
    # 静音段取 50ms（长于检测器 5ms 的真静音确认窗口）
    d1, t1, d2, t2 = 0.05, 1.0, 0.05, 1.0
    x = concat(silence(fs, d1), tone(fs, t1, -12.0),
               silence(fs, d2), tone(fs, t2, -14.0))
    p = CompressorParams()
    r = process(x, fs, p)
    silent = x == 0 if x.ndim == 1 else np.all(x == 0, axis=1)
    # 两段真静音的起点（按拼接长度计算）与中部窗口
    s1 = 0
    s2 = int(round((d1 + t1) * fs))
    mid = np.zeros_like(silent)
    mid[s1 + int(0.02 * fs): s1 + int(0.04 * fs)] = True
    mid[s2 + int(0.02 * fs): s2 + int(0.04 * fs)] = True
    assert mid.sum() > 0 and np.all(silent[mid])
    assert np.all(np.isneginf(r.envelope_db[mid]))
    assert np.all(r.gain_reduction_db[mid] == 0.0)
    # 全局不含 NaN；所有数字静音位置输出严格为 0
    assert not np.any(np.isnan(r.output))
    assert np.all(r.output[silent] == 0.0)
    assert np.all(np.isfinite(r.gain_reduction_db))


def test_single_zero_sample_not_treated_as_silence():
    """两段信号拼接处的单个零样本只是过零点，不应清空包络。"""
    fs = FS
    x = concat(tone(fs, 1.0, -10.0, freq=200.0),
               tone(fs, 1.0, -10.0, freq=300.0))
    r = process(x, fs, CompressorParams(threshold_db=-24.0, ratio=4.0))
    seam = fs
    assert x[seam] == 0.0  # 拼接处确为零样本
    assert np.isfinite(r.envelope_db[seam])
    assert np.isfinite(r.envelope_db[seam + 1])


# ---------- 6. 启动时间按 1/e 口径 ----------

def _level_step(fs: int, low_db: float, high_db: float, t_step: float,
                total: float) -> np.ndarray:
    """恒定电平阶跃（每样本幅度恒定），隔离 attack 分支便于按口径测量。"""
    n = int(round(total * fs))
    s = int(round(t_step * fs))
    x = np.full(n, db_to_amp(np.array(high_db)))
    x[:s] = db_to_amp(np.array(low_db))
    return x


def test_attack_tau_calibration():
    fs = FS
    attack_ms = 20.0
    x = _level_step(fs, -30.0, -6.0, 1.0, 2.0)
    p = CompressorParams(threshold_db=-24.0, ratio=4.0,
                         attack_ms=attack_ms, release_ms=200.0)
    r = process(x, fs, p)
    step = int(round(1.0 * fs))
    env = r.envelope_db
    e0 = env[step - 1]
    e_target = -6.0
    tau_n = int(round(attack_ms / 1000.0 * fs))
    # 一阶 RC 递推从阶跃后第 1 个样本开始：经过 tau 个样本，
    # 已走完的差距比例 = 1 - 1/e（剩余差距才是 1/e）
    frac_travelled = (env[step + tau_n] - e0) / (e_target - e0)
    assert frac_travelled == pytest.approx(1 - 1 / np.e, abs=0.05)
    # 系数本身符合 RC 口径
    assert time_constant_coeff(fs, attack_ms / 1000.0) == pytest.approx(
        1 - np.exp(-1 / (fs * attack_ms / 1000.0)), rel=1e-12)


# ---------- 7. 恢复时间按已声明口径（固定 dB/样本释放）----------

def test_release_rate_calibration():
    from compressor.dsp import time_constant_coeff
    fs = FS
    release_ms = 150.0
    # 恒定电平向下阶跃：隔离 release 分支，包络应以 a_rel dB/样本线性下行
    x = _level_step(fs, -8.0, -28.0, 1.0, 2.0)
    p = CompressorParams(threshold_db=-40.0, ratio=4.0,
                         attack_ms=5.0, release_ms=release_ms)
    r = process(x, fs, p)
    step = int(round(1.0 * fs))
    env = r.envelope_db
    a_rel = time_constant_coeff(fs, release_ms / 1000.0)
    # 取阶跃后 20~80 ms 窗口（held 仍高于新电平、尚未被新峰值接管）：
    # 相邻样本 dB 差恒等于声明的每样本释放量，且严格单调下行
    i0 = step + int(0.020 * fs)
    i1 = step + int(0.080 * fs)
    diffs = -np.diff(env[i0:i1])
    assert np.all(diffs > 0)
    assert np.median(diffs) == pytest.approx(a_rel, rel=0.02)
    # 包络在阶跃点连续有限（拼接零样本不会清空保持值）
    assert np.isfinite(env[step - 1]) and np.isfinite(env[step + 1])
    assert env[step] < env[step - 1]  # 立即进入释放而非保持悬空

def test_faster_attack_reacts_quicker():
    fs = FS
    x = concat(tone(fs, 1.0, -30.0), tone(fs, 1.0, -6.0))
    slow = process(x, fs, CompressorParams(attack_ms=80.0,
                                           release_ms=200.0))
    fast = process(x, fs, CompressorParams(attack_ms=2.0,
                                           release_ms=200.0))
    step = fs
    probe = step + int(0.005 * fs)  # 5ms 处
    assert fast.envelope_db[probe] > slow.envelope_db[probe]
    assert fast.gain_reduction_db[probe] > slow.gain_reduction_db[probe]


# ---------- 8. 导出 + 回读核对 ----------

def test_export_readback_roundtrip(tmp_path):
    fs = FS
    x = make_sample(fs)
    p = CompressorParams(threshold_db=-18.0, ratio=4.0,
                         attack_ms=10.0, release_ms=150.0, makeup_db=0.0)
    r = process(x, fs, p)
    path = os.path.join(tmp_path, "out.wav")
    export_wav(path, r)
    checks = readback_verify(path, r)
    assert checks["ok"], checks
    assert checks["length_match"] and checks["fs_match"]
    assert checks["channels_match"] and checks["peak_within_tol"]
    assert bool(checks["stereo_balance_preserved"]) is True


def test_clipping_blocks_export(tmp_path):
    fs = FS
    x = tone(fs, 1.0, -6.0)
    p = CompressorParams(threshold_db=-24.0, ratio=4.0, makeup_db=12.0)
    r = process(x, fs, p)
    assert r.clipped
    with pytest.raises(ClippingError):
        export_wav(os.path.join(tmp_path, "clip.wav"), r)


# ---------- 9. 自带样例覆盖四类段落 ----------

def test_sample_contains_required_segments():
    fs = FS
    x = make_sample(fs)
    assert x.shape == (12 * fs, 2)
    # 开头与中间静音
    assert np.all(x[: int(0.5 * fs)] == 0.0)
    assert np.all(x[int(9.0 * fs): int(9.5 * fs)] == 0.0)
    # 稳态 / 突增 / 突减 电平关系（RMS 口径）
    lvl_quiet = steady_level_db(x[int(2.0 * fs): int(3.3 * fs)])
    lvl_loud = steady_level_db(x[int(4.5 * fs): int(5.8 * fs)])
    lvl_back = steady_level_db(x[int(7.0 * fs): int(8.3 * fs)])
    assert lvl_quiet == pytest.approx(-24.0 + PEAK_TO_RMS_DB, abs=0.2)
    assert lvl_loud == pytest.approx(-12.0 + PEAK_TO_RMS_DB, abs=0.2)
    assert lvl_back == pytest.approx(-24.0 + PEAK_TO_RMS_DB, abs=0.2)
    # 末段左右不平衡
    tail = x[int(11.0 * fs):]
    assert steady_level_db(tail[:, 0]) == pytest.approx(
        -18.0 + PEAK_TO_RMS_DB, abs=0.2)
    assert steady_level_db(tail[:, 1]) == pytest.approx(
        -12.0 + PEAK_TO_RMS_DB, abs=0.2)
