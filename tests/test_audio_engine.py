"""引擎与端到端 DSP 测试：端点、相关、合听、保护、回读量化误差。"""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from mstool.audio_engine import (
    GAIN_MAX,
    MAX_DURATION_SEC,
    MODE_MID,
    MODE_SIDE,
    MODE_STEREO,
    AudioLoadError,
    Params,
    compute_attenuation,
    compute_stats,
    correlation,
    load_wav,
    make_antiphase_signal,
    make_distinct_ms_signal,
    make_in_phase_signal,
    process_stereo,
    quantization_step,
    render_monitor,
    render_product,
    write_wav,
)

SR = 48000


# ------------------------------------------------------------- 中侧口径

def test_ms_decomposition_definition():
    lr = make_distinct_ms_signal(SR)
    mid = (lr[:, 0] + lr[:, 1]) / 2
    side = (lr[:, 0] - lr[:, 1]) / 2
    m, s = mid, side
    # 引擎口径与题目公式一致
    from mstool.audio_engine import lr_to_ms, ms_to_lr
    em, es = lr_to_ms(lr)
    np.testing.assert_allclose(em, m)
    np.testing.assert_allclose(es, s)
    # 可逆：L=M+S, R=M-S
    np.testing.assert_allclose(ms_to_lr(em, es), lr, atol=1e-14)


def test_unity_gains_restore_original():
    """两个增益为 1 时还原原声。"""
    for sig in (make_in_phase_signal(SR), make_antiphase_signal(SR),
                make_distinct_ms_signal(SR)):
        out = process_stereo(sig, 1.0, 1.0)
        np.testing.assert_allclose(out, sig, atol=1e-14)


def test_side_zero_makes_lr_identical():
    """侧边为 0 时左右相同（全窄），且等于中间分量。"""
    sig = make_distinct_ms_signal(SR)
    out = process_stereo(sig, 1.0, 0.0)
    np.testing.assert_allclose(out[:, 0], out[:, 1], atol=1e-14)
    mid = (sig[:, 0] + sig[:, 1]) / 2
    np.testing.assert_allclose(out[:, 0], mid, atol=1e-14)


def test_side_double_endpoint():
    """侧边 2 倍端点：L'=M+2S, R'=M-2S。"""
    sig = make_distinct_ms_signal(SR)
    out = process_stereo(sig, 1.0, GAIN_MAX)
    mid = (sig[:, 0] + sig[:, 1]) / 2
    side = (sig[:, 0] - sig[:, 1]) / 2
    np.testing.assert_allclose(out[:, 0], mid + 2 * side, atol=1e-14)
    np.testing.assert_allclose(out[:, 1], mid - 2 * side, atol=1e-14)


def test_mid_zero_removes_center():
    sig = make_in_phase_signal(SR)
    out = process_stereo(sig, 0.0, 1.0)
    np.testing.assert_allclose(out, 0.0, atol=1e-14)


def test_not_pan_faking():
    """中侧处理不是左右声像移动：不对称输入下，声像式缩放无法复现结果。"""
    n = SR
    rng = np.random.default_rng(7)
    l = rng.standard_normal(n) * 0.3
    r = rng.standard_normal(n) * 0.3 + 0.2
    sig = np.column_stack((l, r))
    out = process_stereo(sig, 1.0, 1.5)
    # 任何"分别乘常数"的声像方案都保持 L/R 各自比例不变，
    # 而中侧处理改变了通道间的混合关系：检查输出不能表示为 a*L、b*R
    # 用相关以外的直接判据——输出含另一通道成分
    # 若只是缩放，out_L 与 L 完全共线（相关=±1）；中侧处理后不再共线
    c = correlation(out[:, 0], l)
    assert c is not None and abs(c) < 0.999
    # 且侧边加倍确实改变了差异
    assert np.max(np.abs(out[:, 0] - out[:, 1])) != pytest.approx(
        np.max(np.abs(l - r)))


# ------------------------------------------------------------- 三个自生成信号

def test_in_phase_signal_is_center_only():
    sig = make_in_phase_signal(SR)
    np.testing.assert_allclose(sig[:, 0], sig[:, 1])
    stats = compute_stats(sig)
    assert stats.correlation == pytest.approx(1.0, abs=1e-12)
    # 侧边恒为 0
    side = (sig[:, 0] - sig[:, 1]) / 2
    assert np.max(np.abs(side)) == 0.0


def test_antiphase_signal_is_side_only_and_cancels_in_mono():
    sig = make_antiphase_signal(SR)
    np.testing.assert_allclose(sig[:, 0], -sig[:, 1])
    stats = compute_stats(sig)
    # 反相必须显示为 -1，不能被当成同相
    assert stats.correlation == pytest.approx(-1.0, abs=1e-12)
    # 单声道合听完全抵消
    mono = (sig[:, 0] + sig[:, 1]) / 2
    assert np.max(np.abs(mono)) == pytest.approx(0.0, abs=1e-14)
    assert stats.mono_peak == pytest.approx(0.0, abs=1e-14)
    # 中间分量为 0，侧边保留全部能量
    mid = (sig[:, 0] + sig[:, 1]) / 2
    side = (sig[:, 0] - sig[:, 1]) / 2
    assert np.max(np.abs(mid)) == pytest.approx(0.0, abs=1e-14)
    assert np.max(np.abs(side)) > 0.4


def test_distinct_ms_signal_has_both_components():
    sig = make_distinct_ms_signal(SR)
    mid = (sig[:, 0] + sig[:, 1]) / 2
    side = (sig[:, 0] - sig[:, 1]) / 2
    assert np.max(np.abs(mid)) > 0.3
    assert np.max(np.abs(side)) > 0.2
    stats = compute_stats(sig)
    assert stats.correlation is not None
    assert abs(stats.correlation) < 0.99  # 既不完全同相也不完全反相


def test_mono_downmix_three_signals():
    """单声道合听在三组信号上的实际表现。"""
    # 同相：合听保留
    ip = make_in_phase_signal(SR)
    assert compute_stats(ip).mono_peak == pytest.approx(0.5, abs=0.02)
    # 反相：合听抵消
    ap = make_antiphase_signal(SR)
    assert compute_stats(ap).mono_peak == pytest.approx(0.0, abs=1e-12)
    # 混合：合听只保留中间部分（330Hz，幅度 0.5，侧边 880Hz 抵消）
    dm = make_distinct_ms_signal(SR)
    mono = (dm[:, 0] + dm[:, 1]) / 2
    mid = (dm[:, 0] + dm[:, 1]) / 2
    np.testing.assert_allclose(mono, mid, atol=1e-14)
    assert compute_stats(dm).mono_peak == pytest.approx(0.5, abs=0.02)


# ------------------------------------------------------------- 相关系数边界

def test_correlation_invalid_when_silent():
    n = 1024
    assert correlation(np.zeros(n), np.zeros(n)) is None
    assert correlation(np.ones(n) * 0.3, np.ones(n) * 0.3) is None  # 直流常量
    assert correlation(np.zeros(n), np.sin(np.linspace(0, 1, n))) is None


def test_correlation_partial_region():
    sig = make_distinct_ms_signal(SR)
    out = process_stereo(sig, 1.0, 1.0)
    a = compute_stats(out, (0, SR // 2))
    b = compute_stats(out)
    assert a.correlation is not None and b.correlation is not None
    assert a.peak_left > 0


# ------------------------------------------------------------- 超幅与统一保护

def test_protection_unified_scalar_preserves_field():
    # 侧边加倍造成超幅
    sig = make_distinct_ms_signal(SR)
    raw = process_stereo(sig, 1.0, 2.0)
    raw_peak = np.max(np.abs(raw))
    assert raw_peak > 1.0
    att = compute_attenuation(sig, 1.0, 2.0)
    assert att == pytest.approx(1.0 / raw_peak)
    protected, used_att = render_product(sig, Params(1.0, 2.0, MODE_STEREO, True))
    assert used_att == pytest.approx(att)
    assert np.max(np.abs(protected)) <= 1.0 + 1e-12
    # 统一标量：两声道等比缩放，左右比例（声场）不变
    ratio_before = raw[:, 0] / np.where(raw[:, 1] == 0, 1e-30, raw[:, 1])
    ratio_after = protected[:, 0] / np.where(protected[:, 1] == 0, 1e-30,
                                             protected[:, 1])
    mask = np.abs(raw[:, 1]) > 0.05
    np.testing.assert_allclose(ratio_before[mask], ratio_after[mask], rtol=1e-10)


def test_protection_off_allows_clip_and_blocks_export_logic():
    sig = make_distinct_ms_signal(SR)
    out, att = render_product(sig, Params(1.0, 2.0, MODE_STEREO, False))
    assert att == 1.0
    assert np.max(np.abs(out)) > 1.0  # 主窗口据此阻止导出


def test_no_attenuation_when_within_range():
    sig = make_in_phase_signal(SR)
    assert compute_attenuation(sig, 1.0, 1.0) == 1.0


# ------------------------------------------------------------- 单听模式

def test_monitor_modes_do_not_change_product_params():
    sig = make_distinct_ms_signal(SR)
    params = Params(1.3, 1.7, MODE_STEREO, False)
    product_before, _ = render_product(sig, params)
    for mode in (MODE_MID, MODE_SIDE, MODE_STEREO):
        params.mode = mode
        render_monitor(sig, params)
    params.mode = MODE_STEREO
    product_after, _ = render_product(sig, params)
    np.testing.assert_allclose(product_before, product_after)
    assert params.mid_gain == 1.3 and params.side_gain == 1.7


def test_solo_mid_and_side_content():
    sig = make_distinct_ms_signal(SR)
    mid = (sig[:, 0] + sig[:, 1]) / 2
    side = (sig[:, 0] - sig[:, 1]) / 2
    solo_m = render_monitor(sig, Params(1.0, 1.0, MODE_MID, False))
    np.testing.assert_allclose(solo_m[:, 0], solo_m[:, 1])
    np.testing.assert_allclose(solo_m[:, 0], mid)
    solo_s = render_monitor(sig, Params(1.0, 1.0, MODE_SIDE, False))
    np.testing.assert_allclose(solo_s[:, 0], solo_s[:, 1])
    np.testing.assert_allclose(solo_s[:, 0], side)
    # 反相信号单听中间应为静音
    ap = make_antiphase_signal(SR)
    assert np.max(np.abs(render_monitor(ap, Params(mode=MODE_MID)))) == 0.0


# ------------------------------------------------------------- WAV 回读

@pytest.mark.parametrize("subtype", ["PCM_16", "PCM_24", "PCM_32"])
def test_export_roundtrip_quantization(tmp_path, subtype):
    sig = make_distinct_ms_signal(SR)
    params = Params(1.0, 1.4, MODE_STEREO, True)  # 保护开，保证不超幅
    product, att = render_product(sig, params)
    path = tmp_path / "out.wav"
    write_wav(path, product, SR, subtype)
    data, sr = sf.read(str(path), dtype="float64", always_2d=True)
    assert sr == SR and data.shape == product.shape
    tol = quantization_step(subtype)
    err = np.max(np.abs(data - product))
    assert err <= tol + 1e-12  # 允许一个量化单位

    # 回读核对中侧还原
    mid = (data[:, 0] + data[:, 1]) / 2
    side = (data[:, 0] - data[:, 1]) / 2
    recon = np.column_stack((mid + side, mid - side))
    np.testing.assert_allclose(recon, data, atol=1e-12)
    # 峰值核对
    assert abs(np.max(np.abs(data[:, 0])) - np.max(np.abs(product[:, 0]))) <= tol
    assert abs(np.max(np.abs(data[:, 1])) - np.max(np.abs(product[:, 1]))) <= tol


def test_full_narrow_roundtrip(tmp_path):
    """全窄（S=0）导出后左右一致。"""
    sig = make_distinct_ms_signal(SR)
    product, _ = render_product(sig, Params(1.0, 0.0, MODE_STEREO, False))
    path = tmp_path / "narrow.wav"
    write_wav(path, product, SR, "PCM_16")
    data, sr = sf.read(str(path), dtype="float64", always_2d=True)
    tol = quantization_step("PCM_16")
    np.testing.assert_allclose(data[:, 0], data[:, 1], atol=tol)


def test_mono_file_rejected_with_flag(tmp_path):
    path = tmp_path / "mono.wav"
    t = np.arange(SR) / SR
    sf.write(str(path), 0.5 * np.sin(2 * np.pi * 440 * t), SR, subtype="PCM_16")
    audio = load_wav(path)
    assert audio.is_mono is True
    assert audio.samples.shape[1] == 2  # 仅展示用复制
    np.testing.assert_allclose(audio.samples[:, 0], audio.samples[:, 1])


def test_too_long_file_rejected(tmp_path):
    n = int((MAX_DURATION_SEC + 1) * SR)
    sig = np.column_stack((np.zeros(n), np.zeros(n)))
    path = tmp_path / "long.wav"
    sf.write(str(path), sig, SR, subtype="PCM_16")
    with pytest.raises(AudioLoadError):
        load_wav(path)


def test_multichannel_rejected(tmp_path):
    path = tmp_path / "six.wav"
    sf.write(str(path), np.zeros((1024, 6)), SR, subtype="PCM_16")
    with pytest.raises(AudioLoadError):
        load_wav(path)


def test_export_preserves_samplerate_and_length(tmp_path):
    sig = make_antiphase_signal(SR)
    product, _ = render_product(sig, Params(0.8, 1.2, MODE_STEREO, True))
    path = tmp_path / "x.wav"
    write_wav(path, product, SR, "PCM_16")
    info = sf.info(str(path))
    assert info.samplerate == SR
    assert info.frames == sig.shape[0]
    assert info.channels == 2
