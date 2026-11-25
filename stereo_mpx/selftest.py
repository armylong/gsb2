"""无头自检: 不启动 GUI, 数值化验证编码/解码全部关键行为。

运行: .venv/bin/python -m stereo_mpx.selftest
"""
from __future__ import annotations

import os
import tempfile

import numpy as np

from . import dsp

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    results.append((name, bool(ok), detail))
    print(f"[{PASS if ok else FAIL}] {name}" + (f" —— {detail}" if detail else ""))


def main() -> int:
    rng = np.random.default_rng(20261125)

    # 1. 群延迟常量与滤波器约定
    check("解码群延迟为整数音频样本(可精确补偿)",
          dsp.DELAY_AUDIO == 8, f"DELAY_AUDIO={dsp.DELAY_AUDIO}")

    # 2. 三例声道归属: 纯左 / 纯右 / 同相
    for kind, expect_loud in (("pure_left", "L"), ("pure_right", "R")):
        l, r, fs = dsp.make_test_signal(kind)
        mpx, l0, r0 = dsp.encode(l, r, fs)
        dec = dsp.decode(mpx, len(l))
        sep = dsp.separation_db(dec.left, dec.right, dsp.EDGE_MARGIN)
        loud, quiet = (dec.left, dec.right) if expect_loud == "L" else (dec.right, dec.left)
        check(f"{dsp.TEST_LABELS[kind]}: 分离度 > 40 dB", sep > 40, f"分离度={sep:.1f} dB")
        check(f"{dsp.TEST_LABELS[kind]}: 静音声道残余 < -45 dBFS",
              dsp.rms_db(quiet, dsp.EDGE_MARGIN) < -45,
              f"quiet={dsp.rms_db(quiet, dsp.EDGE_MARGIN):.1f} dBFS, "
              f"loud={dsp.rms_db(loud, dsp.EDGE_MARGIN):.1f} dBFS")

    l, r, fs = dsp.make_test_signal("in_phase")
    mpx, l0, r0 = dsp.encode(l, r, fs)
    dec = dsp.decode(mpx, len(l))
    lr_diff = 20 * np.log10(
        np.sqrt(np.mean((dec.left - dec.right)[dsp.EDGE_MARGIN:-dsp.EDGE_MARGIN] ** 2))
        + 1e-20
    )
    check("同相: 差信号为零, 解码 L 与 R 完全一致", lr_diff < -60, f"|L-R|={lr_diff:.1f} dBFS")
    sub_level = dsp.tone_level(mpx, dsp.MPX_FS, dsp.SUBC_F)
    check("同相: 复合信号中无 38 kHz 副载波能量", sub_level < 1e-3,
          f"38kHz 幅度={sub_level:.2e}")
    xt = dsp.crosstalk_db(l0, r0, dec.left, dec.right, dsp.EDGE_MARGIN)
    check("同相: 按输入能量定义的串扰指标为大正值(不误报 0 dB)", xt > 60, f"{xt:.1f} dB")

    # 3. 干净链路重建信噪比(左右两路)
    l, r, fs = dsp.make_test_signal("split")
    mpx, l0, r0 = dsp.encode(l, r, fs)
    dec = dsp.decode(mpx, len(l))
    snr_l = dsp.reconstruction_snr(l0, dec.left, dsp.EDGE_MARGIN)
    snr_r = dsp.reconstruction_snr(r0, dec.right, dsp.EDGE_MARGIN)
    check("干净链路: 左路重建 SNR > 35 dB", snr_l > 35, f"{snr_l:.1f} dB")
    check("干净链路: 右路重建 SNR > 35 dB", snr_r > 35, f"{snr_r:.1f} dB")

    # 4. 单声道解码"听到全曲": split 信号的 440/880 Hz 都在 mono 里
    m440 = dsp.tone_level(dec.mono, dsp.AUDIO_FS, 440)
    m880 = dsp.tone_level(dec.mono, dsp.AUDIO_FS, 880)
    check("单声道只读低频也能听到全曲(440 与 880 Hz 均保留)",
          m440 > 0.1 and m880 > 0.1, f"440Hz={m440:.3f}, 880Hz={m880:.3f}")

    # 5. 频谱读数: 导频 19 kHz 与差信号边带(37/39 kHz)
    f, psd = dsp.spectrum_db(mpx, dsp.MPX_FS)
    band19 = (f >= 18_500) & (f <= 19_500)
    band_side = ((f >= 36_500) & (f <= 37_500)) | ((f >= 38_500) & (f <= 39_500))
    # 导频幅度只有 0.1, 比和信号低约 11 dB, 不能按接近谱顶来要求
    check("复合信号频谱含 19 kHz 导频峰(绝对电平 > -30 dB)",
          psd[band19].max() > -30, f"峰={psd[band19].max():.1f} dB")
    check("复合信号频谱含 37/39 kHz 差信号边带",
          psd[band_side].max() - psd.max() > -12,
          f"边带峰={psd[band_side].max():.1f} dB")

    # 6. 相位偏移: 90° 时差信号被 cos(Δφ)=0 抹掉, 声道串到一起
    dec90 = dsp.decode(mpx, len(l), phase_offset_deg=90.0)
    sep90 = dsp.separation_db(dec90.left, dec90.right, dsp.EDGE_MARGIN)
    check("副载波相移 90°: 分离度塌缩到 < 6 dB(声道串扰)",
          sep90 < 6, f"分离度={sep90:.1f} dB")
    # 180°: 左右互换
    dec180 = dsp.decode(mpx, len(l), phase_offset_deg=180.0)
    flip = np.corrcoef(dec180.left[dsp.EDGE_MARGIN:-dsp.EDGE_MARGIN],
                       r0[dsp.EDGE_MARGIN:-dsp.EDGE_MARGIN])[0, 1]
    check("副载波相移 180°: 左右声道互换(相关 > 0.99)", flip > 0.99, f"相关={flip:.4f}")

    # 7. 找不到导频: 明确退回单声道
    mpx_nop, _, _ = dsp.encode(l, r, fs, include_pilot=False)
    dec_nop = dsp.decode(mpx_nop, len(l))
    check("无导频: 锁定失败且 fallback=True", (not dec_nop.locked) and dec_nop.fallback)
    check("无导频: 退回后 L=R=mono, 且有提示信息",
          np.allclose(dec_nop.left, dec_nop.mono)
          and np.allclose(dec_nop.right, dec_nop.mono)
          and bool(dec_nop.messages))
    # 强制单声道同样退回
    dec_fm = dsp.decode(mpx, len(l), force_mono=True)
    check("强制单声道: fallback=True 且与单声道解码一致",
          dec_fm.fallback and np.allclose(dec_fm.left, dec.mono))

    # 8. 加噪 -20 dB: 仍锁导频, 立体声重建可用
    noisy = dsp.add_noise(mpx, -20.0, rng)
    dec_n = dsp.decode(noisy, len(l), noise_sigma=float(np.std(noisy - mpx)))
    snr_n = dsp.reconstruction_snr(l0, dec_n.left, dsp.EDGE_MARGIN)
    check("-20 dB 白噪声: 导频仍锁定", dec_n.locked,
          f"幅度/RMS={dec_n.pilot.rms_ratio:.3f}")
    check("-20 dB 白噪声: 左路重建 SNR > 15 dB", snr_n > 15, f"{snr_n:.1f} dB")
    # 极强噪声(+20 dB, 噪声 RMS 为信号 10 倍): 长窗相关检测仍可能勉强给出估计,
    # 但幅度比低于门限时必须失锁并退回单声道, 而不是输出乱码立体声
    noisy20 = dsp.add_noise(mpx, 20.0, rng)
    dec_n5 = dsp.decode(noisy20, len(l))
    check("强噪声下失锁时安全退回单声道(不产生乱码立体声)",
          (not dec_n5.locked) and dec_n5.fallback and np.allclose(dec_n5.left, dec_n5.right),
          f"locked={dec_n5.locked}, ratio={dec_n5.pilot.rms_ratio:.3f}")

    # 9. 滤波偏移补偿: 脉冲在解码前后位置一致(允许 1 个音频样本)
    lp, rp, _ = dsp.make_test_signal("pulses", duration=1.0)
    mpx_p, lp0, rp0 = dsp.encode(lp, rp)
    dec_p = dsp.decode(mpx_p, len(lp))
    in_l, out_l = np.argmax(lp0), np.argmax(dec_p.left)
    in_r, out_r = np.argmax(rp0), np.argmax(dec_p.right)
    check("左脉冲位置同步(偏差 ≤ 1 样本)", abs(in_l - out_l) <= 1,
          f"输入@{in_l}, 解码@{out_l}")
    check("右脉冲位置同步(偏差 ≤ 1 样本)", abs(in_r - out_r) <= 1,
          f"输入@{in_r}, 解码@{out_r}")
    # 单声道与立体声两条解码路径之间也必须同步(共用同一低通群延迟)
    check("mono 与立体声输出同位置脉冲对齐",
          abs(np.argmax(dec_p.mono) - np.argmax(dec_p.left)) <= 1)

    # 10. WAV 导出往返(只能导出解码输出)
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "decoded.wav")
        dsp.save_wav(path, dec.left, dec.right)
        l2, r2, fs2 = dsp.load_wav(path)
        n = dsp.EDGE_MARGIN
        corr = np.corrcoef(dec.left[n:-n], l2[n: len(dec.left) - n])[0, 1]
        check("导出 WAV 再读回与解码输出一致(相关 > 0.999)", corr > 0.999, f"相关={corr:.5f}")
        path_m = os.path.join(td, "mono.wav")
        dsp.save_wav(path_m, dec.mono, None)
        lm, rm2, _ = dsp.load_wav(path_m)
        check("单声道 WAV 导出为双声道等幅", np.allclose(lm, rm2, atol=1e-6))

    failed = [r for r in results if not r[1]]
    print("\n" + "=" * 60)
    print(f"共 {len(results)} 项, 通过 {len(results) - len(failed)}, 失败 {len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
