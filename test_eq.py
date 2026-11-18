"""自动验证: 用程序生成的测试音, 以实际处理采样测得的稳态幅度核对频响曲线。

运行: pytest test_eq.py -v
"""
import numpy as np
import pytest

import testtones
from eq_dsp import (
    BandParams, EQChain, EQParams, clamp_params, freq_response_db, max_freq,
    process_offline,
)

TOL_DB = 0.5
MEASURE_FREQS = [60, 120, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000]


def make_params(sr):
    p = EQParams.default(sr)
    p.low = BandParams(enabled=True, freq=150.0, gain_db=6.0)
    p.mid = BandParams(enabled=True, freq=1000.0, gain_db=-8.0, q=2.0)
    p.high = BandParams(enabled=True, freq=8000.0, gain_db=5.0)
    p.master_gain_db = -3.0
    p.bypass = False
    return p


def measure_gains_db(x_in, x_out, sr, freqs):
    """对单声道信号, 用 bin 对齐的 rfft 测各频点稳态增益 (dB)。"""
    n = len(x_in) // 2  # 取后半段, 避开起始瞬态
    x_in = x_in[-n:]
    x_out = x_out[-n:]
    gains = []
    for f in freqs:
        k = int(round(f * n / sr))
        assert abs(k * sr / n - f) < 1e-6, f"频点 {f}Hz 未对齐 bin"
        a_in = 2.0 * abs(np.fft.rfft(x_in)[k]) / n
        a_out = 2.0 * abs(np.fft.rfft(x_out)[k]) / n
        gains.append(20.0 * np.log10(a_out / a_in))
    return np.array(gains)


@pytest.mark.parametrize("sr", [44100, 48000])
def test_offline_processing_matches_curve(sr):
    """离线处理(导出路径)实测稳态增益 vs 频响曲线, 误差 <= 0.5dB。"""
    p = make_params(sr)
    freqs = [f for f in MEASURE_FREQS if f < max_freq(sr)]
    x = testtones.multitone(sr, 2.0, freqs=freqs, amp=0.5)
    y = process_offline(x, p, sr)[:, 0]
    measured = measure_gains_db(x, y, sr, freqs)
    curve = freq_response_db(p, sr, np.array(freqs, dtype=float))
    err = np.abs(measured - curve)
    assert np.max(err) <= TOL_DB, f"sr={sr} 最大误差 {np.max(err):.3f} dB @ {freqs[int(np.argmax(err))]}Hz"


@pytest.mark.parametrize("sr", [44100, 48000])
def test_streaming_chain_matches_curve(sr):
    """实时链(EQChain, 512 样本块)收敛后实测稳态增益 vs 曲线, 误差 <= 0.5dB。"""
    p = make_params(sr)
    freqs = [f for f in MEASURE_FREQS if f < max_freq(sr)]
    x = testtones.multitone(sr, 2.0, freqs=freqs, amp=0.5)
    chain = EQChain(1, sr)
    chain.set_params(p)
    block = 512
    ys = []
    for i in range(0, len(x), block):
        seg = x[i:i + block]
        if len(seg) < block:
            seg = np.pad(seg, (0, block - len(seg)))
        ys.append(chain.process(seg[:, None])[:, 0])
    y = np.concatenate(ys)[:len(x)]
    measured = measure_gains_db(x, y, sr, freqs)
    curve = freq_response_db(p, sr, np.array(freqs, dtype=float))
    err = np.abs(measured - curve)
    assert np.max(err) <= TOL_DB, f"sr={sr} 最大误差 {np.max(err):.3f} dB"


def test_stereo_channels_independent():
    """左右声道共用参数但独立处理: 各自频点增益符合曲线, 且无串音。"""
    sr = 44100
    p = make_params(sr)
    x = testtones.stereo_test(sr, 2.0)
    y = process_offline(x, p, sr)
    curve_l = freq_response_db(p, sr, np.array([80, 200, 500], dtype=float))
    curve_r = freq_response_db(p, sr, np.array([1000, 3000, 9000], dtype=float))
    gl = measure_gains_db(x[:, 0], y[:, 0], sr, [80, 200, 500])
    gr = measure_gains_db(x[:, 1], y[:, 1], sr, [1000, 3000, 9000])
    assert np.max(np.abs(gl - curve_l)) <= TOL_DB
    assert np.max(np.abs(gr - curve_r)) <= TOL_DB
    # 串音检查: 右声道置零, 输出右声道应保持为零
    x2 = x.copy()
    x2[:, 1] = 0.0
    y2 = process_offline(x2, p, sr)
    assert np.max(np.abs(y2[:, 1])) == 0.0


def test_bypass_is_exact_passthrough():
    """全旁路: 收敛后输出与输入逐样本一致 (含总增益也被旁路)。"""
    sr = 44100
    p = make_params(sr)
    p.bypass = True
    p.master_gain_db = 12.0  # 旁路时应被忽略
    x = testtones.multitone(sr, 1.0, amp=0.5)
    chain = EQChain(1, sr)
    chain.set_params(p)
    block = 512
    last = last_in = None
    for i in range(0, len(x) - block + 1, block):
        last_in = x[i:i + block]
        last = chain.process(last_in[:, None])[:, 0]
    np.testing.assert_array_equal(last, last_in)
    # 离线路径同样直通
    y = process_offline(x, p, sr)[:, 0]
    np.testing.assert_array_equal(y, x)


def test_param_change_continuity():
    """播放中连续调参: 输出始终有限, 无爆音级跳变, 幅度不超预期。"""
    sr = 44100
    x = testtones.sine(sr, 3.0, 100.0, amp=0.5)
    chain = EQChain(1, sr)
    p = make_params(sr)
    p.master_gain_db = 0.0
    block = 512
    outs = []
    gains = list(np.arange(-24, 24.1, 2.0))
    for i, gi in enumerate(np.arange(0, len(x) - block + 1, block)):
        p.mid = BandParams(enabled=True, freq=500.0 + 50.0 * (i % 20),
                           gain_db=float(gains[i % len(gains)]), q=1.5)
        chain.set_params(p)
        outs.append(chain.process(x[gi:gi + block, None])[:, 0])
    y = np.concatenate(outs)
    assert np.all(np.isfinite(y)), "输出出现 NaN/Inf"
    max_step = np.max(np.abs(np.diff(y)))
    assert max_step < 0.5, f"相邻样本跳变过大: {max_step}"
    assert np.max(np.abs(y)) < 0.5 * 10 ** (24 / 20) * 1.2, "输出幅度超出增益范围预期"


def test_output_shape_and_rate_unchanged():
    """输出长度与采样率不变 (处理不重采样、不裁剪)。"""
    sr = 48000
    p = make_params(sr)
    x = testtones.stereo_test(sr, 1.0)
    y = process_offline(x, p, sr)
    assert y.shape == x.shape
    x_mono = testtones.multitone(sr, 1.0)
    y_mono = process_offline(x_mono, p, sr)
    assert y_mono.shape == (len(x_mono), 1)


def test_disabled_bands_and_master_in_curve():
    """禁用段不影响曲线; 总增益计入总曲线。"""
    sr = 44100
    p = EQParams.default(sr)
    p.low.enabled = False
    p.mid.enabled = False
    p.high.enabled = False
    p.master_gain_db = -6.0
    freqs = np.array([100.0, 1000.0, 10000.0])
    curve = freq_response_db(p, sr, freqs)
    np.testing.assert_allclose(curve, -6.0, atol=1e-6)
    p.master_gain_db = 0.0
    np.testing.assert_allclose(freq_response_db(p, sr, freqs), 0.0, atol=1e-6)


def test_params_clamped_to_samplerate():
    """参数范围限制在当前采样率可用频率内。"""
    p = EQParams.default(44100)
    p.mid.freq = 30000.0
    p.high.freq = 10.0
    p.mid.gain_db = 40.0
    clamp_params(p, 44100)
    assert p.mid.freq <= max_freq(44100)
    assert p.high.freq >= 20.0
    assert p.mid.gain_db <= 24.0


def test_export_matches_realtime_preview():
    """导出(离线)与实时试听(收敛后)结果一致: 稳态逐样本偏差 < 0.02。"""
    sr = 44100
    p = make_params(sr)
    x = testtones.stereo_test(sr, 2.0)
    y_offline = process_offline(x, p, sr)
    chain = EQChain(2, sr)
    chain.set_params(p)
    block = 512
    ys = []
    for i in range(0, len(x), block):
        seg = x[i:i + block]
        if len(seg) < block:
            seg = np.pad(seg, ((0, block - len(seg)), (0, 0)))
        ys.append(chain.process(seg))
    y_stream = np.concatenate(ys)[:len(x)]
    tail = slice(sr, None)  # 跳过系数平滑过渡段
    diff = np.max(np.abs(y_offline[tail] - y_stream[tail]))
    assert diff < 0.02, f"导出与试听稳态偏差 {diff}"
