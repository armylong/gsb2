"""无头管线测试: 不依赖 GUI, 直接验证 DSP 与样例的地面真值。

运行: .venv/bin/python -m tests.test_pipeline
"""
from __future__ import annotations

import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitchcorrect.dsp import (  # noqa: E402
    analyze_reference, find_gaps, build_correction, resample_correct,
    detect_events, map_event_times, uncorrected_intervals,
)
from pitchcorrect.sample import generate_sample  # noqa: E402
from pitchcorrect.wavio import read_wav  # noqa: E402
from pitchcorrect.export import build_interval_rows, write_intervals_csv  # noqa: E402


def measure_pitch(x: np.ndarray, sr: int, f0: float,
                  t0: float, t1: float) -> float:
    """外差法测一段信号的平均基频。"""
    s0, s1 = int(t0 * sr), int(t1 * sr)
    seg = x[s0:s1].astype(np.float64)
    n_idx = np.arange(seg.size)
    z = seg * np.exp(-1j * 2.0 * np.pi * f0 * n_idx / sr)
    # 简单窄带平滑
    k = max(5, sr // 50)
    kernel = np.ones(k) / k
    z = np.convolve(z, kernel, mode="same")
    phase = np.unwrap(np.angle(z))
    d = np.gradient(phase, 1.0 / sr) / (2.0 * np.pi)
    return f0 + float(np.median(d[k:-k]))


def main() -> int:
    failures: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        tag = "PASS" if cond else "FAIL"
        print(f"[{tag}] {name} {detail}")
        if not cond:
            failures.append(name)

    work = tempfile.mkdtemp(prefix="pitchcorrect_test_")
    wav_path = os.path.join(work, "sample.wav")
    json_path = os.path.join(work, "sample_groundtruth.json")
    truth = generate_sample(wav_path, json_path=json_path)
    sr = truth["sr"]

    data, sr2 = read_wav(wav_path)
    check("wav 读回采样率一致", sr2 == sr, f"({sr2} vs {sr})")
    check("wav 为立体声", data.shape[1] == 2, f"shape={data.shape}")
    file_duration = data.shape[0] / sr
    check("文件时长符合磁带时间(略短于真实 8s)",
          abs(file_duration - truth["duration_file_s"]) < 0.02,
          f"{file_duration:.3f}s")
    duration = file_duration

    content, ref = data[:, 0], data[:, 1]
    f_nom = truth["f_nom"]

    # 1) 参考分析
    an = analyze_reference(ref, sr, f_nom)
    valid_frac = an.valid.mean()
    check("有效帧占比合理(0.65~0.95)", 0.65 < valid_frac < 0.95,
          f"valid={valid_frac:.2%}")

    # 与地面真值 e(t) 对照(在文件时间轴上, 取有效帧)
    tt = an.frame_time
    e_true_frames = (
        0.004
        + 0.012 * np.sin(2 * np.pi * 0.15 * tt)
        + 0.004 * np.sin(2 * np.pi * 2.3 * tt + 1.1)
        + 0.0015 * np.sin(2 * np.pi * 7.0 * tt)
    )
    err = an.deviation - e_true_frames
    valid_err = err[an.valid]
    valid_err = valid_err[np.isfinite(valid_err)]
    rmse = float(np.sqrt((valid_err ** 2).mean())) if valid_err.size else float("inf")
    check("频率偏差跟踪地面真值 RMSE < 0.2%", rmse < 0.002, f"rmse={rmse:.5f}")

    # 2) 缺口检测: 一个 short 一个 long, 位置接近样例设置
    gaps = find_gaps(an, max_bridge_s=0.5)
    shorts = [g for g in gaps if g.kind == "short"]
    longs = [g for g in gaps if g.kind == "long"]
    check("检测到 1 个短缺口", len(shorts) == 1,
          f"{[(round(g.start,2), round(g.end,2)) for g in shorts]}")
    check("检测到 1 个长缺口", len(longs) == 1,
          f"{[(round(g.start,2), round(g.end,2)) for g in longs]}")
    if longs:
        g = longs[0]
        check("长缺口位置与真值吻合(±0.15s)",
              abs(g.start - truth["dropouts_file_s"][1]["file_start"]) < 0.15
              and abs(g.end - truth["dropouts_file_s"][1]["file_end"]) < 0.15,
              f"({g.start:.2f}-{g.end:.2f})")

    # 3) 校正曲线 + 重采样
    curve = build_correction(an, gaps, slow_tau_s=0.8, fast_tau_s=0.03,
                             fast_amount=1.0, bridge_short=True,
                             edge_mode="zero")
    uncorr = uncorrected_intervals(an, gaps, True, "zero", duration)
    corr = resample_correct(content, sr, curve["frame_time"],
                            curve["dev_total"], curve["valid_curve"], uncorr)
    out = corr["out"]
    check("校正后时长与输入一致", out.size == content.size)

    mono_map = corr["map_in_to_out"]
    check("时间映射严格单调向前", bool(np.all(np.diff(mono_map) > 0)),
          f"min diff={np.diff(mono_map).min():.3e}")

    # 4) 音高: 校正前 880 音被带速带偏, 校正后应回到 880
    # 选 0.6~1.0s: 有效参考区且无打点
    pitch_before = measure_pitch(content, sr, 880.0, 0.6, 1.0)
    pitch_after = measure_pitch(out, sr, 880.0, 0.6, 1.0)
    check("校正前内容音高确实偏离 880Hz", abs(pitch_before - 880.0) > 2.0,
          f"f_before={pitch_before:.2f} Hz")
    check("校正后内容音高回到 880Hz(±1.5Hz)", abs(pitch_after - 880.0) < 1.5,
          f"f_after={pitch_after:.2f} Hz")

    # 再验证另一个有效区间(慢漂相位不同)
    pitch_after2 = measure_pitch(out, sr, 880.0, 3.2, 3.7)
    check("另一有效区间音高同样回到 880Hz(±1.5Hz)",
          abs(pitch_after2 - 880.0) < 1.5, f"f={pitch_after2:.2f} Hz")

    # 5) 事件间距: 前两个打点真实间隔 1.8s
    ev_before = detect_events(content, sr)
    ev_after = detect_events(out, sr)
    check("两轨都检出 >=4 个打点",
          ev_before.size >= 4 and ev_after.size >= 4,
          f"before={ev_before.size}, after={ev_after.size}")
    if ev_after.size >= 2:
        gap01_after = ev_after[1] - ev_after[0]
        gap01_true = truth["click_times_true_s"][1] - truth["click_times_true_s"][0]
        check("校正后前两个打点间距逼近真值 1.8s(±0.03s)",
              abs(gap01_after - gap01_true) < 0.03,
          f"got={gap01_after:.3f} true={gap01_true:.3f}")

    # 事件时间经映射换算后, 与直接在校正轨上检出的位置一致
    if ev_before.size:
        mapped = map_event_times(ev_before, mono_map, sr)
        err_ev = np.abs(mapped[: ev_after.size] - ev_after[: mapped.size])
        check("事件经时间映射换算与重采样检出位置一致(±0.02s)",
              float(err_ev.max()) < 0.02, f"max err={err_ev.max():.4f}")

    # 6) 长缺口内不校正
    lg = longs[0]
    m_gap = (np.arange(out.size) / sr >= lg.start) & \
            (np.arange(out.size) / sr <= lg.end)
    check("长缺口区间标记为未校正", not corr["corrected_mask"][m_gap].any())
    check("长缺口区间速率为 1(原样保留)",
          abs(corr["speed"][m_gap] - 1.0).max() < 1e-9)

    # 7) 短缺口被桥接(区间内有有效曲线)
    sg = shorts[0]
    m_short = (curve["frame_time"] >= sg.start) & (curve["frame_time"] <= sg.end)
    check("短缺口被平滑桥接(曲线有效)",
          bool(curve["valid_curve"][m_short].all()))

    # 不允许桥接时, 短缺口也保持未校正
    curve_nb = build_correction(an, gaps, 0.8, 0.03, 1.0,
                                bridge_short=False, edge_mode="zero")
    check("关闭桥接后短缺口不插值",
          not curve_nb["valid_curve"][m_short].any())

    # 8) 跟随程度: fast_amount=0 时快抖动残留, =1 时压下去
    c0 = build_correction(an, gaps, 0.8, 0.03, 0.0)
    r0 = resample_correct(content, sr, c0["frame_time"], c0["dev_total"],
                          c0["valid_curve"], uncorr)
    p_slow_only = measure_pitch(r0["out"], sr, 880.0, 0.6, 1.0)
    # 0.6~1.0s 窗口较长, 快抖在窗内平均掉, 改用短窗瞬时残差对比
    def fast_residual(sig: np.ndarray) -> float:
        f = measure_pitch(sig, sr, 880.0, 0.70, 0.80)
        return abs(f - 880.0)
    check("全跟随比只修慢漂的瞬时残差更小(或相当)",
          fast_residual(out) <= fast_residual(r0["out"]) + 0.5,
          f"full={fast_residual(out):.2f}Hz slow-only={fast_residual(r0['out']):.2f}Hz")
    check("只修慢漂时整体音高仍基本归位(±3Hz)",
          abs(p_slow_only - 880.0) < 3.0, f"f={p_slow_only:.2f} Hz")

    # 9) 区间表覆盖整条时间轴且无重叠
    rows = build_interval_rows(an, gaps, duration, bridge_short=True,
                               edge_mode="zero")
    check("区间表从 0 开始、到 duration 结束",
          abs(rows[0]["start_s"]) < 1e-6 and
          abs(rows[-1]["end_s"] - duration) < 0.02,
          f"{rows[0]['start_s']}..{rows[-1]['end_s']}")
    total_cov = sum(r["duration_s"] for r in rows)
    check("区间表无重叠无缺口地覆盖全时长",
          abs(total_cov - duration) < 0.05, f"cover={total_cov:.3f}")
    states = {r["state"] for r in rows}
    check("区间表包含长缺口与有效状态",
          "long_gap_uncorrected" in states and "reference_valid" in states,
          str(states))
    csv_path = os.path.join(work, "intervals.csv")
    write_intervals_csv(csv_path, rows)
    check("CSV 写出且非空", os.path.getsize(csv_path) > 100)

    # 10) 边缘无参考: 造一条开头 0.5s 静音的参考
    ref_edge = ref.copy()
    ref_edge[: int(0.5 * sr)] = 0.0
    an_e = analyze_reference(ref_edge, sr, f_nom)
    gaps_e = find_gaps(an_e)
    c_zero = build_correction(an_e, gaps_e, 0.8, 0.03, 1.0,
                              edge_mode="zero")
    uncorr_zero = uncorrected_intervals(an_e, gaps_e, True, "zero", duration)
    r_zero = resample_correct(content, sr, c_zero["frame_time"],
                              c_zero["dev_total"], c_zero["valid_curve"],
                              uncorr_zero)
    check("edge=zero 时头部不校正(speed=1)",
          abs(r_zero["speed"][: int(0.4 * sr)] - 1.0).max() < 1e-9)
    c_hold = build_correction(an_e, gaps_e, 0.8, 0.03, 1.0,
                              edge_mode="hold")
    r_hold = resample_correct(content, sr, c_hold["frame_time"],
                              c_hold["dev_total"], c_hold["valid_curve"],
                              uncorrected_intervals(an_e, gaps_e, True,
                                                    "hold", duration))
    # hold: 头部保持区内部(取 0.1~0.4s, 避开第一帧时刻的边界样本)恒速
    hold_seg = r_hold["speed"][int(0.1 * sr): int(0.4 * sr)]
    check("edge=hold 时头部保持恒定速率(且不同于 1)",
          np.abs(np.diff(hold_seg)).max() < 1e-9
          and abs(hold_seg[0] - 1.0) > 1e-6,
          f"speed={hold_seg[0]:.5f}")

    print()
    if failures:
        print(f"{len(failures)} 项失败: {failures}")
        return 1
    print("全部通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
