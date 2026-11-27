"""命令行入口: demo(生成示例并自动验证) / synth(合成) / verify(导出对照)。

示例:
  python -m band_vocoder demo --outdir tmp_demo
  python -m band_vocoder synth voice.wav --carrier harmonic --out out.wav
  python -m band_vocoder verify out.wav
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from . import INTERNAL_SR
from .audio_io import (fit_modulator, load_mono, loop_carrier, measure,
                       normalize_loudness, save_wav)
from .synth import (alternating_band_modulator, build_filterbank,
                    downsample_mean, erb_edges, filter_bank,
                    harmonic_carrier, sine_carrier, vocode)


def _print_measure(tag: str, m: dict) -> None:
    print(f"[{tag}] sr={m['sr']}Hz 时长={m['duration_s']:.3f}s "
          f"({m['samples']}采样) RMS={m['rms']:.4f} peak={m['peak']:.4f} "
          f"首50msRMS={m['head_rms']:.4f} 尾50msRMS={m['tail_rms']:.4f}")


def _make_carrier(kind: str, duration_s: float, sr: int,
                  freq: float, f0: float, n_harm: int) -> np.ndarray:
    if kind == "sine":
        return sine_carrier(duration_s, sr, freq=freq)
    if kind == "harmonic":
        return harmonic_carrier(duration_s, sr, f0=f0, n_harmonics=n_harm)
    raise ValueError(f"未知内置载波类型: {kind}")


def _resolve_duration(mode: str, fixed_s: float | None,
                      n_mod: int, n_car: int, sr: int) -> int:
    if mode == "mod":
        return n_mod
    if mode == "car":
        return n_car
    if mode == "fixed":
        if fixed_s is None:
            raise ValueError("固定时长模式需要 --seconds")
        return max(1, int(round(fixed_s * sr)))
    raise ValueError(mode)


# ---------------------------------------------------------------- demo
def cmd_demo(args: argparse.Namespace) -> int:
    sr = INTERNAL_SR
    n_bands = args.bands
    seg_s = args.segment
    n_segments = 2 * n_bands + 1            # 上行 + 静音 + 下行
    total_s = n_segments * seg_s + 0.05
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    mod = alternating_band_modulator(total_s, sr, n_bands=n_bands,
                                     segment_s=seg_s)
    car_sine = sine_carrier(total_s, sr, freq=args.freq)
    car_harm = harmonic_carrier(total_s, sr, f0=args.f0,
                                n_harmonics=args.harmonics)

    res_sine = vocode(mod, car_sine, sr, n_bands, args.attack, args.release)
    res_harm = vocode(mod, car_harm, sr, n_bands, args.attack, args.release)

    save_wav(outdir / "modulator_alternating.wav", mod, sr)
    save_wav(outdir / "carrier_sine.wav", car_sine, sr)
    save_wav(outdir / "carrier_harmonic.wav", car_harm, sr)
    save_wav(outdir / "output_sine.wav", res_sine["output"], sr)
    save_wav(outdir / "output_harmonic.wav", res_harm["output"], sr)

    lines = _demo_report(mod, res_sine, res_harm, sr, n_bands, seg_s)
    report = "\n".join(lines)
    (outdir / "report.txt").write_text(report + "\n", encoding="utf-8")
    print(report)
    print(f"\n文件已写入 {outdir}/")
    return 0


def _demo_report(mod: np.ndarray, res_sine: dict, res_harm: dict,
                 sr: int, n_bands: int, seg_s: int) -> list[str]:
    """逐时间窗检查调制声与合成输出的能量落在哪个频带, 静音窗是否全静。"""
    sos_list, edges = build_filterbank(n_bands, sr)
    mod_bands = filter_bank(mod, sos_list)
    out_sine_bands = filter_bank(res_sine["output"], sos_list)
    out_harm_bands = filter_bank(res_harm["output"], sos_list)
    n_seg = int(round(seg_s * sr))
    expected = list(range(n_bands)) + [-1] + list(range(n_bands - 1, -1, -1))

    def window_energy(bands: np.ndarray, a: int, b: int) -> np.ndarray:
        return np.sqrt(np.mean(bands[:, a:b] ** 2, axis=1))

    # 用各自最强窗口的总能量做静音基准, 阈值 1%
    n_win = len(expected)
    m_tot, h_tot, s_tot = [], [], []
    m_rows, h_rows, s_rows = [], [], []
    for win in range(n_win):
        a, b = win * n_seg, min((win + 1) * n_seg, len(mod))
        m_rms = window_energy(mod_bands, a, b)
        h_rms = window_energy(out_harm_bands, a, b)
        s_rms = window_energy(out_sine_bands, a, b)
        m_rows.append(m_rms), h_rows.append(h_rms), s_rows.append(s_rms)
        m_tot.append(np.sqrt(np.sum(m_rms ** 2)))
        h_tot.append(np.sqrt(np.sum(h_rms ** 2)))
        s_tot.append(np.sqrt(np.sum(s_rms ** 2)))
    m_floor, h_floor, s_floor = max(m_tot), max(h_tot), max(s_tot)

    # 载波在各带是否有能量: 输出只能在载波有能量的带里发声。
    ce_sine = res_sine["carrier_energy"]
    ce_harm = res_harm["carrier_energy"]
    s_dead = ce_sine < 0.01 * ce_sine.max()
    h_dead = ce_harm < 0.01 * ce_harm.max()
    s_alive, h_alive = ~s_dead, ~h_dead

    lines = [
        "分频段交替示例验证",
        "=" * 72,
        f"频带边界(Hz): {np.round(edges, 1).tolist()}",
        f"时间窗: 每窗 {seg_s:.3f}s, 共 {n_win} 窗, 第 {n_bands} 窗应为静音",
        "主导带 = 该窗 RMS 最大的频带; 静音 = 窗口总能量低于最强窗的 1%",
        "",
        f"{'窗':>2} {'期望':>4} | {'调制:主导带/静音':>14} | "
        f"{'谐波输出:主导带/静音':>18} | {'单频输出:主导带/静音':>18}",
        "-" * 72,
    ]
    ok = True
    silence_win = n_bands  # 设计上中间那一窗是静音
    # 死带判据相对该带自己的载波能量: 载波在该带本来就低于最强带 1%,
    # 那么该带任何窗口的输出也必须低于全局最强输出的 10%(20dB 余量),
    # 滤波器边缘泄漏通常远小于此, 而活带发声窗在 30% 以上, 不会误伤。
    h_peak = max(float(r.max()) for r in h_rows)
    s_peak = max(float(r.max()) for r in s_rows)
    h_leak = 0.1 * h_peak
    s_leak = 0.1 * s_peak
    for win, expect in enumerate(expected):
        m_dom, h_dom, s_dom = (int(np.argmax(r[win])) for r in
                               (m_rows, h_rows, s_rows))
        m_sil = m_tot[win] < 0.01 * m_floor
        h_sil = h_tot[win] < 0.01 * h_floor
        s_sil = s_tot[win] < 0.01 * s_floor
        if expect >= 0:
            # 调制声分带必须与设计时序一一对应。
            ok &= (m_dom == expect and not m_sil)
            # 活带: 发声窗必须显著高于静音窗(包络在起伏);
            # 死带: 任何窗口都只能低于固定泄漏上限。
            if h_alive[expect]:
                ok &= float(h_rows[win][expect]) > 5.0 * float(
                    h_rows[silence_win][expect] + 1e-12)
            else:
                ok &= float(h_rows[win][expect]) < h_leak
            if s_alive[expect]:
                ok &= float(s_rows[win][expect]) > 5.0 * float(
                    s_rows[silence_win][expect] + 1e-12)
            else:
                ok &= float(s_rows[win][expect]) < s_leak
        else:
            # 静音窗: 三条信号的窗口总能量都必须低于各自 1% 阈值。
            ok &= m_sil and h_sil and s_sil
        lines.append(
            f"{win:>2} {str(expect):>4} | "
            f"{m_dom:>8} {'静音' if m_sil else '发声':>4} | "
            f"{h_dom:>12} {'静音' if h_sil else '发声':>4} | "
            f"{s_dom:>12} {'静音' if s_sil else '发声':>4}"
        )

    # 谐波输出在载波覆盖的频带上, 主导带必须落在期望带或其相邻带
    # (窄带滤波器的振铃会把边界能量分给邻带, 但不允许跑到更远的带)。
    for win, expect in enumerate(expected):
        if expect >= 0 and h_alive[expect]:
            ok &= abs(int(np.argmax(h_rows[win])) - expect) <= 1
    lines += [
        "",
        "载波在各频带的原始能量(RMS), 对照单频 vs 谐波:",
        "(标记 * 的频带能量低于最强带的 1%, 视为该载波在此带无能量)",
        "-" * 72,
        f"{'频带':>3} {'频率范围Hz':>18} {'单频载波':>10} {'谐波载波':>10}",
    ]
    for i in range(n_bands):
        lines.append(
            f"{i:>3} {f'{edges[i]:.0f}-{edges[i+1]:.0f}':>18} "
            f"{ce_sine[i]:>8.5f}{'*' if s_dead[i] else ' '} "
            f"{ce_harm[i]:>8.5f}{'*' if h_dead[i] else ' '}"
        )
    lines += [
        "",
        f"单频载波有 {int(s_dead.sum())}/{n_bands} 个频带无能量, "
        f"谐波载波有 {int(h_dead.sum())}/{n_bands} 个频带无能量",
        "单频载波下这些频带无论调制包络如何起伏都不会出声;",
        "谐波载波覆盖全部频带时, 词句的起伏才能完整传递。",
        "输出由载波分带乘调制包络后相加得到, 全程不混回原调制声。",
        "",
        f"自动判定: {'通过 (时间窗与频带一一对应, 静音窗全静)' if ok else '未通过, 请检查参数'}",
    ]
    return lines


# ---------------------------------------------------------------- synth
def cmd_synth(args: argparse.Namespace) -> int:
    sr = INTERNAL_SR
    mod, mod_sr0 = load_mono(args.modulator, sr)

    if args.carrier_type == "file":
        if not args.carrier:
            print("file 载波需要 --carrier 路径", file=sys.stderr)
            return 2
        car, car_sr0 = load_mono(args.carrier, sr)
    else:
        car_sr0 = sr
        # 先用一个足够长的缓冲, 时长对齐阶段再截断/循环
        car = _make_carrier(args.carrier_type, len(mod) / sr + 1.0,
                            sr, args.freq, args.f0, args.harmonics)

    target_n = _resolve_duration(args.duration, args.seconds,
                                 len(mod), len(car), sr)
    mod_a = fit_modulator(mod, target_n)
    car_a = loop_carrier(car, target_n, sr)

    res = vocode(mod_a, car_a, sr, args.bands, args.attack, args.release)
    out, scale = normalize_loudness(res["output"])
    save_wav(args.out, out, sr)

    print(f"调制声原始: sr={mod_sr0}Hz 长度={len(mod)}采样 "
          f"({len(mod)/sr:.3f}s)")
    if args.carrier_type == "file":
        print(f"载波原始:   sr={car_sr0}Hz 长度={len(car)}采样 "
              f"({len(car)/sr:.3f}s)")
    else:
        print(f"载波: 内置 {args.carrier_type}")
    print(f"时长模式={args.duration} 目标长度={target_n}采样 "
          f"({target_n/sr:.3f}s), 输出响度缩放={scale:.3f}")
    _print_measure("输出", measure(out, sr))
    print(f"已保存: {args.out}")
    return 0


# ---------------------------------------------------------------- verify
def cmd_verify(args: argparse.Namespace) -> int:
    x, sr0 = load_mono(args.wav, INTERNAL_SR)
    m = measure(x, sr0)
    _print_measure(Path(args.wav).name, m)
    if sr0 != INTERNAL_SR:
        print(f"注意: 文件采样率 {sr0}Hz 与内部 {INTERNAL_SR}Hz 不同, "
              "重采样后参与测量")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="band_vocoder",
                                description="通道声码器本地短音工具")
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("demo", help="生成分频段交替示例并自动验证静音/频带时序")
    d.add_argument("--outdir", default="tmp_demo")
    d.add_argument("--bands", type=int, default=8)
    d.add_argument("--segment", type=float, default=0.25, help="每段秒数")
    d.add_argument("--attack", type=float, default=10.0)
    d.add_argument("--release", type=float, default=60.0)
    d.add_argument("--freq", type=float, default=220.0, help="单频载波频率")
    d.add_argument("--f0", type=float, default=110.0, help="谐波载波基频")
    d.add_argument("--harmonics", type=int, default=80)
    d.set_defaults(func=cmd_demo)

    s = sub.add_parser("synth", help="用一条调制声和一条载波做声码器合成")
    s.add_argument("modulator", help="调制声 wav (短, 单声道或多声道自动混合)")
    s.add_argument("--carrier", help="载波 wav; carrier-type=file 时必填")
    s.add_argument("--carrier-type", default="harmonic",
                   choices=["sine", "harmonic", "file"])
    s.add_argument("--freq", type=float, default=220.0)
    s.add_argument("--f0", type=float, default=110.0)
    s.add_argument("--harmonics", type=int, default=24)
    s.add_argument("--bands", type=int, default=16)
    s.add_argument("--attack", type=float, default=10.0)
    s.add_argument("--release", type=float, default=60.0)
    s.add_argument("--duration", choices=["mod", "car", "fixed"],
                   default="mod", help="界面选定的时长基准")
    s.add_argument("--seconds", type=float, default=None,
                   help="duration=fixed 时的固定秒数")
    s.add_argument("--out", default="vocoder_out.wav")
    s.set_defaults(func=cmd_synth)

    v = sub.add_parser("verify", help="打印 wav 的采样率/时长/首尾响度")
    v.add_argument("wav")
    v.set_defaults(func=cmd_verify)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
