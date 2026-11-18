"""DSP 核心验证: 重建误差、选区外不变、边缘连续性、抑制目标、
邻域修补约束与首尾选区。"""

from __future__ import annotations

import numpy as np
import pytest
from scipy.signal import butter, sosfilt

from audio_repair.processing import (
    InpaintError, ProcessOptions, STFTParams, Selection, SelectionError,
    outside_region_unchanged, process_selection,
)

SR = 44100
PARAMS = STFTParams()


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

def _clean_stereo(dur: float = 6.0, seed: int = 1):
    rng = np.random.default_rng(seed)
    t = np.arange(int(dur * SR)) / SR
    left = 0.4 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 660 * t)
    right = 0.4 * np.sin(2 * np.pi * 277 * t + 1) + 0.2 * np.sin(2 * np.pi * 990 * t)
    clean = np.stack([left, right], axis=1)
    # 少量去相关背景噪声, 左右独立
    clean += 0.01 * rng.standard_normal(clean.shape)
    return clean.astype(np.float64), t


def _band_energy(x: np.ndarray, sr: int, f0: float, f1: float) -> float:
    """指定频带能量 (RMS 平方和)。"""
    sos = butter(6, [f0, f1], btype="bandpass", fs=sr, output="sos")
    y = sosfilt(sos, x)
    return float(np.mean(y ** 2))


@pytest.fixture(scope="module")
def tone_case():
    clean, t = _clean_stereo()
    damaged = clean.copy()
    t0, t1 = int(2.0 * SR), int(4.0 * SR)
    tone = 0.3 * np.sin(2 * np.pi * 3200 * t)
    damaged[t0:t1, 0] += tone[t0:t1]   # 窄带干扰只在左声道
    return clean, damaged, (t0, t1)


@pytest.fixture(scope="module")
def burst_case():
    clean, t = _clean_stereo(dur=4.0, seed=2)
    rng = np.random.default_rng(7)
    sos = butter(6, [1500, 6000], btype="bandpass", fs=SR, output="sos")
    damaged = clean.copy()
    # 靠近开头和结尾各一个短时爆发
    spans = [(int(0.10 * SR), int(0.26 * SR)),
             (int(3.72 * SR), int(3.88 * SR))]
    for j0, j1 in spans:
        for ch in range(2):
            n = rng.standard_normal(j1 - j0)
            n = sosfilt(sos, n)
            n /= np.max(np.abs(n))
            damaged[j0:j1, ch] += 0.5 * n * np.hanning(j1 - j0)
    return clean, damaged, spans


# ---------------------------------------------------------------------------
# 1. 基本不变量: 长度 / 采样率语义 / 不修改输入
# ---------------------------------------------------------------------------

def test_shape_and_length_unchanged(tone_case):
    _, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2800.0, 3600.0, (0,))
    out = process_selection(damaged, SR, sel, ProcessOptions())
    assert out.shape == damaged.shape
    assert out.dtype == np.float64

    snapshot = damaged.copy()
    process_selection(damaged, SR, sel, ProcessOptions())
    np.testing.assert_array_equal(damaged, snapshot)  # 输入不被修改


def test_mono_preserved():
    rng = np.random.default_rng(3)
    x = 0.3 * np.sin(2 * np.pi * 300 * np.arange(SR) / SR)
    x += 0.01 * rng.standard_normal(SR)
    sel = Selection(int(0.2 * SR), int(0.8 * SR), 2000.0, 3000.0, (0,))
    out = process_selection(x, SR, sel, ProcessOptions(mode="inpaint"))
    assert out.ndim == 1
    assert out.shape == x.shape


# ---------------------------------------------------------------------------
# 2. 不处理时重建误差 (STFT -> ISTFT 往返)
# ---------------------------------------------------------------------------

def test_roundtrip_error_with_strength_zero(tone_case):
    _, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2800.0, 3600.0, (0,))
    out = process_selection(
        damaged, SR, sel, ProcessOptions(mode="attenuate", strength=0.0))
    # 强度为 0 等于不处理: 逐样本完全相等
    np.testing.assert_array_equal(out, damaged)
    rel = np.max(np.abs(out - damaged)) / np.max(np.abs(damaged))
    assert rel == 0.0


def test_unselected_channel_identical(tone_case):
    _, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2800.0, 3600.0, (0,))   # 只处理左声道
    out = process_selection(damaged, SR, sel, ProcessOptions())
    # 右声道逐样本不变 (无串音、不错位)
    np.testing.assert_array_equal(out[:, 1], damaged[:, 1])


# ---------------------------------------------------------------------------
# 3. 选区外逐样本不变
# ---------------------------------------------------------------------------

def test_outside_region_sample_exact(tone_case):
    _, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2800.0, 3600.0, (0, 1))
    out = process_selection(damaged, SR, sel, ProcessOptions())
    diff = outside_region_unchanged(damaged, out, sel, SR, PARAMS)
    assert np.max(diff) == 0.0, "时域 crossfade 区域之外出现了修改"


def test_outside_spectrum_preserved(tone_case):
    """选区时间范围之外的频谱内容必须保持 (能量度量)。"""
    _, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2800.0, 3600.0, (0,))
    out = process_selection(damaged, SR, sel,
                            ProcessOptions(strength=1.0))
    before = damaged[: t0 - PARAMS.n_fft, 0]
    after = out[: t0 - PARAMS.n_fft, 0]
    e0 = _band_energy(before, SR, 100, 10000)
    e1 = _band_energy(after, SR, 100, 10000)
    assert abs(e1 - e0) / e0 < 1e-12


# ---------------------------------------------------------------------------
# 4. 边缘连续性: 无爆音、导数平滑
# ---------------------------------------------------------------------------

def test_no_edge_clicks(tone_case):
    _, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2800.0, 3600.0, (0,))
    out = process_selection(damaged, SR, sel,
                            ProcessOptions(strength=1.0))
    # crossfade 边界处的逐样本差分不得显著超过自然信号差分
    for edge in (max(0, t0 - PARAMS.n_fft),
                 min(damaged.shape[0], t1 + PARAMS.n_fft)):
        if edge <= 1 or edge >= out.shape[0] - 1:
            continue
        edge_jump = abs(out[edge, 0] - out[edge - 1, 0])
        natural = np.percentile(np.abs(np.diff(damaged[:, 0])), 99.9)
        assert edge_jump <= natural * 2.0, (
            f"边界 {edge} 出现爆音: jump={edge_jump:.4f} natural99.9={natural:.4f}")


def test_frequency_edge_smoothness(tone_case):
    """频率软掩码: 掩码权重为 0 的频点 (过渡带之外) STFT 必须逐点不变,
    过渡带内权重连续变化、无突变。"""
    from audio_repair.processing import (_frequency_weight, stft,
                                         _time_weight)
    _, damaged, (t0, t1) = tone_case
    opts = ProcessOptions(strength=1.0)
    sel = Selection(t0, t1, 2800.0, 3600.0, (0,))
    out = process_selection(damaged, SR, sel, opts)

    Z0 = stft(damaged[:, 0], PARAMS)
    Z1 = stft(out[:, 0], PARAMS)
    n_freq, n_frames = Z0.shape
    freqs = np.linspace(0, SR / 2, n_freq)
    frame_period = PARAMS.hop / SR
    times = np.arange(n_frames) * frame_period
    fw = _frequency_weight(freqs, sel.f0, sel.f1, opts.freq_transition_hz)
    tw = _time_weight(times, t0 / SR, t1 / SR, 8e-3)
    outside = fw == 0.0
    # 选区时间内部、过渡带之外的频点: 谱值逐点相等
    inside_frames = (times > t0 / SR + 0.05) & (times < t1 / SR - 0.05)
    # STFT 往返数值误差实测约为谱峰的 2.5e-4 (~-72 dB); 取 5e-4 容差
    tol = np.max(np.abs(Z0)) * 5e-4
    np.testing.assert_allclose(
        Z0[np.ix_(outside, inside_frames)],
        Z1[np.ix_(outside, inside_frames)],
        atol=tol, rtol=0.0)
    # 软掩码本身连续: 先单调非减到 1, 再单调非减回 0, 单步增量有界
    nz = fw[fw > 0]
    peak_idx = int(np.argmax(fw))
    assert np.all(np.diff(fw[:peak_idx + 1]) >= -1e-12)
    assert np.all(np.diff(fw[peak_idx:]) <= 1e-12)
    assert np.max(np.diff(nz)) < 0.5
    # 时间权重同时覆盖到边界 (两端都不是硬切)
    assert tw.max() == 1.0
    assert tw[0] == 0.0 and tw[-1] == 0.0


# ---------------------------------------------------------------------------
# 5. 窄带干扰抑制目标 (合成信号可测)
# ---------------------------------------------------------------------------

def test_narrowband_suppression_target(tone_case):
    clean, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2900.0, 3500.0, (0,))
    out = process_selection(damaged, SR, sel,
                            ProcessOptions(mode="attenuate", strength=0.9))
    band_damaged = _band_energy(damaged[t0:t1, 0], SR, 3000, 3400)
    band_out = _band_energy(out[t0:t1, 0], SR, 3000, 3400)
    suppression_db = 10 * np.log10(band_damaged / band_out)
    assert suppression_db >= 15.0, (
        f"窄带抑制仅 {suppression_db:.1f} dB, 目标 ≥15 dB")
    # 修复后该频带应比受损信号更接近干净参考
    band_clean = _band_energy(clean[t0:t1, 0], SR, 3000, 3400)
    assert abs(band_out - band_clean) < abs(band_damaged - band_clean)


def test_strength_monotonic(tone_case):
    _, damaged, (t0, t1) = tone_case
    sel = Selection(t0, t1, 2900.0, 3500.0, (0,))
    energies = []
    for s in (0.0, 0.3, 0.6, 1.0):
        out = process_selection(
            damaged, SR, sel,
            ProcessOptions(mode="attenuate", strength=s))
        energies.append(_band_energy(out[t0:t1, 0], SR, 3000, 3400))
    # 强度越大, 干扰频带能量越低 (单调不增)
    diffs = np.diff(energies)
    assert np.all(diffs <= 1e-12), f"强度单调性被破坏: {energies}"


# ---------------------------------------------------------------------------
# 6. 邻域修补
# ---------------------------------------------------------------------------

def test_inpaint_reduces_burst_error(burst_case):
    clean, damaged, spans = burst_case
    j0, j1 = spans[0]
    sel = Selection(j0, j1, 1800.0, 5500.0, (0, 1))
    out = process_selection(
        damaged, SR, sel,
        ProcessOptions(mode="inpaint", strength=1.0))
    err_before = np.mean((damaged[j0:j1] - clean[j0:j1]) ** 2)
    err_after = np.mean((out[j0:j1] - clean[j0:j1]) ** 2)
    assert err_after < 0.6 * err_before, (
        f"邻域修补改善不足: {err_before:.2e} -> {err_after:.2e}")


def test_inpaint_needs_neighborhood():
    x = np.zeros(SR)
    x += 0.2 * np.sin(2 * np.pi * 400 * np.arange(SR) / SR)
    # 选区顶到奈奎斯特, 上方没有参考频带 -> 必须拒绝
    sel = Selection(int(0.2 * SR), int(0.5 * SR), 18000.0, 22050.0, (0,))
    with pytest.raises(InpaintError):
        process_selection(x, SR, sel,
                          ProcessOptions(mode="inpaint", strength=1.0))


def test_inpaint_does_not_claim_recovery():
    """文档/实现层面: 修补结果是邻域估计, 不等于干净信号本身。"""
    rng = np.random.default_rng(11)
    t = np.arange(2 * SR) / SR
    clean = 0.3 * np.sin(2 * np.pi * 500 * t)
    damaged = clean.copy()
    j0, j1 = int(0.5 * SR), int(0.7 * SR)
    damaged[j0:j1] += 0.5 * rng.standard_normal(j1 - j0)
    sel = Selection(j0, j1, 1200.0, 6000.0, (0,))
    out = process_selection(damaged, SR, sel,
                            ProcessOptions(mode="inpaint", strength=1.0))
    # 误差显著下降但不会精确恢复原始样本
    assert np.mean((out[j0:j1] - clean[j0:j1]) ** 2) < np.mean(
        (damaged[j0:j1] - clean[j0:j1]) ** 2)
    assert not np.allclose(out[j0:j1], clean[j0:j1], atol=1e-4)


# ---------------------------------------------------------------------------
# 7. 空选区 / 越界选区反馈
# ---------------------------------------------------------------------------

def test_empty_selection_rejected():
    x = np.zeros(SR)
    with pytest.raises(SelectionError):
        process_selection(x, SR, Selection(100, 100, 100.0, 200.0, (0,)),
                          ProcessOptions())
    with pytest.raises(SelectionError):
        process_selection(x, SR, Selection(100, 200, 300.0, 300.0, (0,)),
                          ProcessOptions())


def test_out_of_range_clamped_or_rejected(tone_case):
    _, damaged, _ = tone_case
    n = damaged.shape[0]
    # 部分越界 -> 夹紧后仍可处理, 不抛异常
    sel = Selection(n - SR // 2, n + SR * 10, 1000.0, 2000.0, (0,))
    out = process_selection(damaged, SR, sel, ProcessOptions())
    assert out.shape == damaged.shape
    # 通道越界 -> 报错
    with pytest.raises(SelectionError):
        process_selection(damaged, SR,
                          Selection(0, 100, 100.0, 200.0, (5,)),
                          ProcessOptions())


# ---------------------------------------------------------------------------
# 8. 双通道同步: 联动不错位、不折叠
# ---------------------------------------------------------------------------

def test_stereo_linked_aligned_and_not_collapsed(burst_case):
    clean, damaged, spans = burst_case
    j0, j1 = spans[1]   # 靠近结尾的选区
    sel = Selection(j0, j1, 1800.0, 5500.0, (0, 1))
    out = process_selection(damaged, SR, sel,
                            ProcessOptions(mode="inpaint", strength=1.0))
    # 未处理区域左右差异与原信号一致 (没有被折成单声道)
    head = slice(0, j0 - PARAMS.n_fft)
    diff_before = damaged[head, 0] - damaged[head, 1]
    diff_after = out[head, 0] - out[head, 1]
    np.testing.assert_array_equal(diff_before, diff_after)
    # 处理区域两侧长度/位置完全对齐 (同一时间频率选区)
    assert out[:, 0].shape == out[:, 1].shape
    # 左右仍然不同 (没有折叠)
    assert not np.allclose(out[j0:j1, 0], out[j0:j1, 1])


def test_single_channel_touch_only_one(tone_case):
    _, damaged, (t0, t1) = tone_case
    sel_r = Selection(t0, t1, 2900.0, 3500.0, (1,))
    out = process_selection(damaged, SR, sel_r, ProcessOptions())
    np.testing.assert_array_equal(out[:, 0], damaged[:, 0])
    assert not np.allclose(out[:, 1], damaged[:, 1])


# ---------------------------------------------------------------------------
# 9. 首尾选区完整输出
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("edge", ["head", "tail"])
def test_selections_at_edges_complete(burst_case, edge):
    clean, damaged, spans = burst_case
    n = damaged.shape[0]
    if edge == "head":
        j0, j1 = spans[0]
        sel = Selection(0, j1 + 100, 1800.0, 5500.0, (0, 1))
    else:
        j0, j1 = spans[1]
        sel = Selection(max(0, j0 - 100), n, 1800.0, 5500.0, (0, 1))
    out = process_selection(damaged, SR, sel,
                            ProcessOptions(mode="inpaint", strength=1.0))
    assert out.shape == damaged.shape
    # 首尾样本必须是有限值且被实际处理 (与输入有差异)
    assert np.all(np.isfinite(out))
    region = out[:j1] if edge == "head" else out[j0:]
    region_in = damaged[:j1] if edge == "head" else damaged[j0:]
    assert np.max(np.abs(region - region_in)) > 0.0
    # 对干净参考的误差下降
    err_after = np.mean((out[j0:j1] - clean[j0:j1]) ** 2)
    err_before = np.mean((damaged[j0:j1] - clean[j0:j1]) ** 2)
    assert err_after < err_before
