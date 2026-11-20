"""无头验证脚本：不需要 GUI，直接跑 DSP 全链路检查。

运行：python -m limiter.verify
"""

from __future__ import annotations

import os
import tempfile

import numpy as np

from . import dsp, sources, wavio

FS = 48000.0
PASS = "PASS"
FAIL = "FAIL"
_failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    tag = PASS if cond else FAIL
    print(f"[{tag}] {name}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        _failures.append(name)


def streaming_compensated(x: np.ndarray, ceiling_db: float, lookahead: int,
                          release_ms: float, fs: float, linked: bool
                          ) -> np.ndarray:
    """用"延迟线 + 前瞻"的因果流式方式重跑一遍，再做延迟补偿。

    若离线渲染的延迟补偿正确，补偿后的结果必须与 dsp.limit 的输出逐采样相同。
    """
    mono = x.ndim == 1
    x2 = x[:, None] if mono else x
    n, nch = x2.shape
    L = int(lookahead)

    # 输入尾部补 L 个零，保证最后一个采样也能走完延迟线。
    padded = np.vstack([x2, np.zeros((L, nch))])
    out = np.zeros_like(padded)
    delay = np.zeros((L, nch)) if L > 0 else None

    # 每来一个新采样，用"目前可见的全部输入"重算到当前时刻的增益包络，
    # 取与即将离开延迟线的那个采样同索引的增益值施加。
    for k in range(padded.shape[0]):
        visible = padded[: k + 1]
        if nch == 2 and linked:
            drive = np.max(np.abs(visible), axis=1)
            env = dsp.gain_envelope(drive, 10 ** (ceiling_db / 20),
                                    L, int(round(release_ms * 1e-3 * fs)))
            env = np.repeat(env[:, None], 2, axis=1)
        else:
            env = np.column_stack([
                dsp.gain_envelope(visible[:, c], 10 ** (ceiling_db / 20),
                                  L, int(round(release_ms * 1e-3 * fs)))
                for c in range(nch)
            ])
        if L == 0:
            out[k] = padded[k] * env[-1]
            continue
        sig_idx = k - L
        if sig_idx < 0:
            # 延迟线还没灌满：输出预延迟静音（离线补偿时会被丢弃）。
            out[k] = 0.0
            delay[k] = padded[k]
        else:
            leaving = delay[0]
            delay = np.roll(delay, -1, axis=0)
            delay[-1] = padded[k]
            out[k] = leaving * env[sig_idx]

    # 延迟补偿：整体左移 L 个采样，截回原长度。
    comp = out[L : L + n]
    return comp[:, 0] if mono else comp


def test_pulse_controlled_and_aligned() -> None:
    x, meta = sources.gen_pulse(FS)
    res = dsp.limit(x, ceiling_db=-1.0, lookahead=128, release_ms=20, fs=FS)
    sp = dsp.sample_peak(res.y)[0]
    ceil = 10 ** (-1.0 / 20)
    check("窄脉冲采样峰不超过 ceiling", sp <= ceil + 1e-12,
          f"peak={dsp.to_dbfs(sp):.3f} dBFS, ceiling=-1.000 dBFS")
    check("输出与输入等长", res.y.shape == x.shape,
          f"{x.shape} -> {res.y.shape}")
    # 脉冲位置必须原样保留（延迟补偿正确的直接证据）。
    for i in meta["peaks_idx"]:
        check(f"脉冲索引 {i} 保持为该处最大采样",
              int(np.argmax(np.abs(res.y))) in meta["peaks_idx"])
    check("报告的延迟等于提前量", res.delay_samples == 128)
    # 尖峰处增益确实压下去了。
    i = meta["peaks_idx"][0]
    check("尖峰处实际增益 < 1", res.gain[i] < 1.0,
          f"gain[{i}]={res.gain[i]:.4f}")


def test_streaming_equivalence() -> None:
    x, _ = sources.gen_pulse(FS)
    res = dsp.limit(x, -1.0, lookahead=128, release_ms=20, fs=FS)
    comp = streaming_compensated(x, -1.0, 128, 20.0, FS, linked=False)
    check("流式延迟线补偿后与离线输出逐采样相同",
          np.allclose(res.y, comp, atol=1e-12),
          f"max|diff|={np.max(np.abs(res.y - comp)):.2e}")

    xs, _ = sources.gen_stereo(FS)
    r2 = dsp.limit(xs, -1.0, lookahead=64, release_ms=10, fs=FS, linked=True)
    c2 = streaming_compensated(xs, -1.0, 64, 10.0, FS, linked=True)
    check("立体声联动下流式/离线结果相同",
          np.allclose(r2.y, c2, atol=1e-12),
          f"max|diff|={np.max(np.abs(r2.y - c2)):.2e}")


def test_short_file() -> None:
    # 48 个采样的文件，lookahead 给到 256（远长于文件）。
    x, meta = sources.gen_short(FS, duration_ms=1.0)
    n = x.size
    res = dsp.limit(x, -3.0, lookahead=256, release_ms=50, fs=FS)
    ceil = 10 ** (-3.0 / 20)
    sp = dsp.sample_peak(res.y)[0]
    check("短于提前量的文件仍被限幅", sp <= ceil + 1e-12,
          f"n={n}, lookahead=256, peak={dsp.to_dbfs(sp):.3f} dBFS")
    check("短文件输出等长", res.y.size == n)
    check("短文件脉冲索引不变",
          np.argmax(np.abs(res.y)) == meta["peaks_idx"][0])


def test_tone() -> None:
    x, _ = sources.gen_tone(FS, amp=0.9)
    res = dsp.limit(x, -6.0, lookahead=64, release_ms=30, fs=FS)
    sp = dsp.sample_peak(res.y)[0]
    ceil = 10 ** (-6.0 / 20)
    check("连续音稳态不超线", sp <= ceil + 1e-12,
          f"peak={dsp.to_dbfs(sp):.3f} dBFS")
    # 稳态段增益应恒定（无抖动调制）。
    mid = res.gain[len(res.gain) // 2 : -len(res.gain) // 4]
    check("稳态增益包络平直", np.ptp(mid) < 1e-9, f"ptp={np.ptp(mid):.2e}")


def test_stereo_link_vs_independent() -> None:
    x, meta = sources.gen_stereo(FS)
    i = meta["peaks_idx"][0]
    r_link = dsp.limit(x, -1.0, 128, 20, FS, linked=True)
    r_ind = dsp.limit(x, -1.0, 128, 20, FS, linked=False)

    check("联动模式两声道共用一条增益曲线",
          np.allclose(r_link.gain[:, 0], r_link.gain[:, 1]))
    # 声像保持的正确定义：同一个采样上左右被乘了同一个增益，
    # 因此非零采样处 L/R 比例逐点不变（用输出/输入比值核对）。
    nz = np.max(np.abs(x), axis=1) > 1e-9
    ratio_in = x[nz, 0] / x[nz, 1]
    ratio_out = r_link.y[nz, 0] / r_link.y[nz, 1]
    check("联动模式声像保持（逐采样 L/R 比例不变）",
          np.allclose(ratio_in, ratio_out, rtol=1e-9, atol=1e-12),
          f"max ratio diff={np.max(np.abs(ratio_in - ratio_out)):.2e}")
    # 独立模式：尖峰只在 R，L 声道包络应全程为 1（不被牵连，声像会偏移）。
    check("独立模式未触发声道增益恒为 1",
          np.allclose(r_ind.gain[:, 0], 1.0),
          f"max|gL-1|={np.max(np.abs(r_ind.gain[:, 0] - 1)):.2e}")
    check("独立模式 R 声道在尖峰处被压", r_ind.gain[i, 1] < 1.0)
    check("联动模式 L 声道在尖峰窗口内被一起拉低",
          np.min(r_link.gain[:, 0]) < 1.0)


def test_true_peak() -> None:
    # 方波类信号在采样点之间有明显的重建过冲。
    n = 2048
    t = np.arange(n)
    x = 0.95 * np.sign(np.sin(2 * np.pi * 0.23 * t))
    tp_in = dsp.true_peak_levels(x, FS)[0]
    sp_in = dsp.sample_peak(x)[0]
    check("方波素材存在采样间过冲", tp_in > sp_in + 1e-6,
          f"sample={dsp.to_dbfs(sp_in):.3f} dBFS, "
          f"true={dsp.to_dbfs(tp_in):.3f} dBFS")

    # 不开保护：采样峰达标，但重建峰可能仍超线。
    r_plain = dsp.limit(x, -1.0, 64, 10, FS, true_peak_guard=False)
    tp_plain = dsp.true_peak_levels(r_plain.y, FS)[0]
    sp_plain = dsp.sample_peak(r_plain.y)[0]
    check("普通限幅保证采样峰", sp_plain <= 10 ** (-1 / 20) + 1e-12)

    # 开保护：重建峰也必须达标。
    r_guard = dsp.limit(x, -1.0, 64, 10, FS, true_peak_guard=True)
    tp_guard = dsp.true_peak_levels(r_guard.y, FS)[0]
    sp_guard = dsp.sample_peak(r_guard.y)[0]
    check("true-peak 保护后重建峰不超线",
          tp_guard <= 10 ** (-1 / 20) + 1e-9,
          f"true={dsp.to_dbfs(tp_guard):.3f} dBFS, "
          f"sample={dsp.to_dbfs(sp_guard):.3f} dBFS, "
          f"iters={r_guard.tp_guard_iters}")
    check("不开保护时重建峰确实更差（对照有效）",
          tp_plain >= tp_guard - 1e-12)


def test_true_peak_narrow_pulse() -> None:
    # 1 采样窄脉冲 + true-peak 保护：插值最大点会随缩放在采样/插值点间易位，
    # 是保护迭代最容易卡住的场景，单声道与立体声联动/独立都要达标。
    xp, _ = sources.gen_pulse(FS)
    r = dsp.limit(xp, -1.0, 128, 20, FS, true_peak_guard=True)
    tp = dsp.true_peak_levels(r.y, FS)[0]
    check("窄脉冲 true-peak 保护后重建峰达标",
          tp <= 10 ** (-1 / 20) + 1e-9,
          f"true={dsp.to_dbfs(tp):.4f} dBFS, iters={r.tp_guard_iters}")
    check("窄脉冲保护后采样峰更不超线",
          dsp.sample_peak(r.y)[0] <= r.ceiling + 1e-12)
    check("窄脉冲保护后长度/定位不变",
          r.y.shape == xp.shape
          and np.argmax(np.abs(r.y)) == sources.gen_pulse(FS)[1]["peaks_idx"][0])

    xs, _ = sources.gen_stereo(FS)
    for linked in (True, False):
        rs = dsp.limit(xs, -1.0, 128, 20, FS, linked=linked,
                       true_peak_guard=True)
        tps = dsp.true_peak_levels(rs.y, FS)
        check(f"立体声{'联动' if linked else '独立'} true-peak 达标",
              tps.max() <= 10 ** (-1 / 20) + 1e-9,
              f"true={dsp.to_dbfs(tps.max()):.4f} dBFS, "
              f"iters={rs.tp_guard_iters}")


def test_wav_roundtrip() -> None:
    x, _ = sources.gen_stereo(FS)
    res = dsp.limit(x, -1.5, 128, 20, FS, linked=True)
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "out_float.wav")
        wavio.write_wav(p, res.y, FS, subtype="FLOAT")
        xr, fsr = wavio.read_wav(p)
        check("float WAV 回读采样率正确", fsr == FS)
        check("float WAV 回读无损（无位深二次截断）",
              np.allclose(xr, res.y, atol=1e-7),
              f"max|diff|={np.max(np.abs(xr - res.y)):.2e}")
        check("导出文件采样峰仍不超线",
              dsp.sample_peak(xr).max() <= res.ceiling + 1e-9)

        p16 = os.path.join(d, "out_pcm16.wav")
        wavio.write_wav(p16, res.y, FS, subtype="PCM_16")
        x16, _ = wavio.read_wav(p16)
        check("PCM16 WAV 回读形状一致", x16.shape == res.y.shape)
        check("PCM16 导出无硬切（全部 <=1）", np.max(np.abs(x16)) <= 1.0)


def test_release_rate() -> None:
    x, _ = sources.gen_pulse(FS)
    lookahead, release_ms = 128, 20.0
    res = dsp.limit(x, -1.0, lookahead, release_ms, FS)
    rel = int(round(release_ms * 1e-3 * FS))
    diffs = np.diff(res.gain)
    # 回升段每采样增量不得超过 1/rel；下降段不受限。
    rises = diffs[diffs > 0]
    check("恢复斜率受限（每采样 <= 1/release_samples）",
          rises.size == 0 or np.max(rises) <= 1.0 / rel + 1e-15,
          f"max rise={rises.max() if rises.size else 0:.2e}, "
          f"limit={1.0 / rel:.2e}")


def main() -> int:
    test_pulse_controlled_and_aligned()
    test_streaming_equivalence()
    test_short_file()
    test_tone()
    test_stereo_link_vs_independent()
    test_true_peak()
    test_true_peak_narrow_pulse()
    test_wav_roundtrip()
    test_release_rate()
    print("-" * 64)
    if _failures:
        print(f"{len(_failures)} 项失败: {_failures}")
        return 1
    print("全部检查通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
