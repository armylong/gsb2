"""关键行为验证:全部基于实际导出的 WAV 采样数据断言,不根据配置推测。

运行: python3 verify.py
覆盖:左右分配 / 反相抵消 / 指定采样点延时 / 峰值保护(不削波、左右相对电平不变)
     / 未路由输入不出现 / 静音相关程度无有效值 / 渲染确定性 / 导出回读一致(±1 LSB)
"""
import json
import os
import sys

import numpy as np

import dsp
import make_test_tones

BASE = os.path.dirname(os.path.abspath(__file__))
TMP = os.path.join(BASE, "exports", "_verify")
TONE = os.path.join(BASE, "test_tones", "test_6ch.wav")

FAILS = []


def check(name, cond, detail=""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")
    if not cond:
        FAILS.append(name)


def load_cfg(preset):
    with open(os.path.join(BASE, "configs", preset), encoding="utf-8") as f:
        return json.load(f)["channels"]


def run(samples, cfg, protect, fname):
    """走与导出完全相同的处理+写盘+读回路径。"""
    out, info = dsp.process(samples, cfg, protect)
    path = os.path.join(TMP, fname)
    dsp.write_wav(path, out)
    back, sr = dsp.read_wav(path)
    return out, info, back, sr


def main():
    os.makedirs(TMP, exist_ok=True)
    make_test_tones.main()
    samples, sr = dsp.read_wav(TONE)
    n, c = samples.shape
    check("测试音为 48kHz", sr == 48000, f"sr={sr}")
    check("测试音为 6 声道", c == 6, f"C={c}")

    # 1. 左右分配:声道1 -> 左,右应全无声,左与声道1 一致(±1 LSB)
    out, info, back, _ = run(samples, load_cfg("ch1_to_left.json"), False, "t1.wav")
    check("输出采样数与输入一致", back.shape[0] == n, f"{back.shape[0]} vs {n}")
    diff = np.abs(back[:, 0] * 32768 - np.rint(samples[:, 0] * 32768)).max()
    check("ch1→左 数据一致(±1 LSB)", diff <= 1, f"max diff={diff:.1f} LSB")
    check("ch1→左 右声道完全无声", np.all(back[:, 1] == 0))

    # 2. 反相抵消:声道1 + 声道2(反极性) -> 左,两路同相 0.8 正弦应抵消
    out, info, back, _ = run(samples, load_cfg("cancel_pair.json"), False, "t2.wav")
    resid = np.abs(back[:, 0]).max() * 32768
    check("反相抵消 左声道≈静音", resid <= 1, f"残余峰值={resid:.2f} LSB")

    # 3. 延时:声道5 脉冲@1000,延时 480 -> 应出现在 1480,之前全静音
    out, info, back, _ = run(samples, load_cfg("impulse_delay.json"), False, "t3.wav")
    pos = int(np.argmax(np.abs(back[:, 0])))
    check("延时 480 采样 脉冲位于 1480", pos == 1480, f"实际位置={pos}")
    check("延时引入的开头为静音", np.all(back[:1480, :] == 0))
    check("延时后长度不变", back.shape[0] == n)

    # 4. 峰值保护:声道1+2 同相叠加到左右,峰值约 1.6 -> 统一衰减后不削波
    out, info, back, _ = run(samples, load_cfg("clip_protect.json"), True, "t4.wav")
    check("保护前峰值超满幅", info["peak_pre"] > dsp.FULL_SCALE,
          f"pre={info['peak_pre']:.6f}")
    check("保护后峰值不超满幅", info["peak_post"] <= dsp.FULL_SCALE + 1e-12,
          f"post={info['peak_post']:.6f}")
    check("回读数据不削波", np.abs(back).max() * 32768 <= 32767,
          f"max={np.abs(back).max() * 32768:.0f}")
    exp_atten = dsp.FULL_SCALE / info["peak_pre"]
    check("统一衰减量正确", abs(info["atten"] - exp_atten) < 1e-12,
          f"atten={info['atten']:.8f}")
    ratio_pre = info["peak_pre_l"] / info["peak_pre_r"]
    ratio_post = info["peak_post_l"] / info["peak_post_r"]
    check("左右相对电平不变", abs(ratio_pre - ratio_post) < 1e-9,
          f"pre={ratio_pre:.9f} post={ratio_post:.9f}")
    exp_q = np.clip(np.rint(out * 32768), -32768, 32767)
    rdiff = np.abs(back * 32768 - exp_q).max()
    check("回读与预期一致(±1 LSB)", rdiff <= 1, f"max diff={rdiff:.1f} LSB")

    # 5. 未路由的输入不出现在输出
    off = [{"invert": False, "delay": 0,
            "L": {"on": False, "gain": 0.0}, "R": {"on": False, "gain": 0.0}}
           for _ in range(c)]
    out, info, back, _ = run(samples, off, False, "t5.wav")
    check("全部未路由时输出为静音", np.all(back == 0))

    # 6. 静音时相关程度无有效值
    check("静音相关程度为 None", dsp.correlation(np.zeros(1000), np.zeros(1000)) is None)
    out, info, back, _ = run(samples, load_cfg("ch1_to_left.json"), False, "t6.wav")
    check("一侧无声时相关程度为 None",
          dsp.correlation(back[:, 0], back[:, 1]) is None)

    # 7. 渲染确定性:同一设置两次处理结果逐采样一致
    cfg = load_cfg("impulse_delay.json")
    o1, _ = dsp.process(samples, cfg, False)
    o2, _ = dsp.process(samples, cfg, False)
    check("同一设置渲染结果确定一致", np.array_equal(o1, o2))

    # 8. 延时上限 960 可用且截尾正确
    cfg = load_cfg("impulse_delay.json")
    cfg[4]["delay"] = 960
    out, info, back, _ = run(samples, cfg, False, "t8.wav")
    pos = int(np.argmax(np.abs(back[:, 0])))
    check("延时 960 采样 脉冲位于 1960", pos == 1960, f"实际位置={pos}")

    print()
    if FAILS:
        print(f"共 {len(FAILS)} 项失败: {', '.join(FAILS)}")
        return 1
    print("全部验证通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
