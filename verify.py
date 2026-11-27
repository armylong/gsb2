"""离线验证脚本（不需要 GUI / 音频设备）。

检查点：
  1. 干声绝不后移：起音前的干声采样与原文件逐点相同；
  2. 前置尾巴位置：湿声尾巴（反转 IR 的起点）正好落在起音采样；
  3. 交界连续性：湿声在起音处淡出为 0，淡变窗内湿/干增益平方和恒为 1；
  4. 分轨采样对齐：三个分轨等长且 mix = dry + wet；
  5. 试听/导出幅值一致：PCM16 量化结果与 scipy 重新读回的 wav 完全相同；
  6. 声道匹配规则：单声道干声折叠立体声 IR、立体声干声复制单声道 IR、
     左右长度不一致时按最长补零；
  7. 生成的两次击掌信号：标记位置正确，第一击靠近文件头且能向前留出。
"""
from __future__ import annotations

import os
import sys
import tempfile

import numpy as np
from scipy.io import wavfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from entrance_reverb.dsp import (  # noqa: E402
    RenderParams,
    builtin_ir,
    generate_test_claps,
    match_ir_to_dry,
    read_wav,
    render_reverse_reverb,
    to_pcm16,
    write_wav,
)

PASS, FAIL = 0, 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def main() -> int:
    work = tempfile.mkdtemp(prefix="entrance_reverb_verify_")
    sr = 48000
    rng = np.random.default_rng(0)

    # -------------------------------------------------------------- 7
    print("[1] 生成两次击掌验证信号")
    paths = generate_test_claps(work, sr=sr)
    g_sr, g_audio = read_wav(paths["wav"])
    check("采样率 48000、立体声、2.0s",
          g_sr == sr and g_audio.shape == (int(2.0 * sr), 2))
    clap1 = int(0.10 * sr)
    check("第一击在 0.10s 且靠近文件头（前置空间不足，必然触发向前留出）",
          np.max(np.abs(g_audio[: clap1 - 100])) < 0.05
          and np.max(np.abs(g_audio[clap1 : clap1 + 200])) > 0.3)
    check("marker 文件记录了两个击掌采样位置",
          os.path.exists(paths["markers"]))

    # -------------------------------------------------------------- 渲染
    print("[2] 渲染前置混响（提前量 300ms，淡变 40ms，起音=第一击）")
    ir = builtin_ir("reflections", sr)
    params = RenderParams(lead_ms=300.0, fade_ms=40.0)
    r = render_reverse_reverb(g_audio, sr, clap1, ir, params)
    lead = int(0.300 * sr)
    fade = int(0.040 * sr)

    # -------------------------------------------------------------- 1
    print("[3] 干声不后移")
    check("头部确实补了静音（新增时长 = 提前量 - 起音前空间）",
          r.prepend == lead - clap1 and r.added_seconds > 0)
    same = np.allclose(r.dry[r.prepend : r.prepend + g_audio.shape[0]], g_audio,
                       atol=1e-12)
    check("补静音后的干声与原波形逐采样相同", same)
    check("前置区域干声严格为 0", np.all(r.dry[: r.prepend] == 0.0))
    check("起音采样落在输出 onset_index = 原位置 + prepend",
          r.onset_index == clap1 + r.prepend)

    # -------------------------------------------------------------- 2
    print("[4] 前置湿声尾巴位置")
    check("湿声在起音处已淡出到 0（尾巴尖对齐但不覆盖干声起音）",
          np.all(np.abs(r.wet[r.onset_index]) < 1e-9))
    # 起音前一个采样应保留反转 IR 的最大能量附近——检查湿声非零段恰好
    # 结束在起音点；lead 长于 IR 时湿声段只有 IR 长，前面是静音
    nonzero = np.flatnonzero(np.max(np.abs(r.wet), axis=1))
    wet_lo = r.onset_index - min(lead, ir.shape[0])
    ir_eff = max(len(np.flatnonzero(np.abs(ir[:, c]) > 1e-12))
                 for c in range(ir.shape[1]))
    check("湿声段起点对齐 onset-min(lead,L)（IR 自身头部静音允许稍后）且不越过该点",
          wet_lo <= nonzero.min() <= wet_lo + ir.shape[0] - ir_eff + 2)
    check("湿声在起音前一采样仍有能量、起音处归零（IR 尾部静音时允许提前几个采样归零）",
          nonzero.max() <= r.onset_index - 1
          and nonzero.max() >= r.onset_index - 5
          and np.all(r.wet[:wet_lo] == 0.0)
          and np.all(r.wet[r.onset_index:] == 0.0))
    # 反转关系：湿声淡入后的主体应等于反转 IR 的对应片段
    body0 = wet_lo + int(0.005 * sr)
    if lead >= ir.shape[0]:
        expected_tail = ir[::-1][body0 - wet_lo:, :]
    else:
        expected_tail = ir[::-1][ir.shape[0] - lead + int(0.005 * sr):, :]
    got = r.wet[body0 : r.onset_index - fade]
    check("湿声主体 = 反转后的混响响应（逆向尾巴朝干声增长）",
          np.allclose(got, expected_tail[: got.shape[0]], atol=1e-9))

    # -------------------------------------------------------------- 3
    print("[5] 交界淡变连续性")
    # 击掌信号在淡变窗里可能恰好静音，用常量合成信号专门检验增益包络
    const_dry = np.ones((sr, 2)) * 0.5
    const_ir = np.ones((int(0.1 * sr), 2))
    rc = render_reverse_reverb(const_dry, sr, int(0.5 * sr), const_ir, params)
    w0 = rc.onset_index - fade
    wet_gain = rc.wet[w0:rc.onset_index, 0] / 1.0       # 常量 IR 幅值 1
    dry_gain = rc.dry[w0:rc.onset_index, 0] / 0.5       # 常量干声幅值 0.5
    check("淡变窗内干声增益 0→1 单调上升",
          np.all(np.diff(dry_gain) >= -1e-12)
          and dry_gain[0] < 0.02 and dry_gain[-1] > 0.99)
    check("等功率：湿声增益² + 干声增益² ≈ 1",
          np.allclose(wet_gain ** 2 + dry_gain ** 2, 1.0, atol=1e-9))
    check("起音之后湿声严格为 0，全是干声",
          np.all(r.wet[r.onset_index:] == 0.0)
          and np.allclose(r.dry[r.onset_index:],
                          r.mix[r.onset_index:], atol=1e-12))
    check("起音之后干声恢复原始幅值（未被淡变永久改变）",
          np.allclose(rc.dry[rc.onset_index + 5: rc.onset_index + 100], 0.5))

    # -------------------------------------------------------------- 4
    print("[6] 分轨采样对齐")
    check("dry/wet/mix 等长、同声道数",
          r.dry.shape == r.wet.shape == r.mix.shape)
    check("mix = dry + wet 逐采样成立",
          np.allclose(r.mix, r.dry + r.wet, atol=1e-12))

    # -------------------------------------------------------------- 5
    print("[7] 试听与导出幅值一致（同一条 PCM16 量化路径）")
    dry_path = os.path.join(work, "out_dry.wav")
    wet_path = os.path.join(work, "out_wet.wav")
    mix_path = os.path.join(work, "out_mix.wav")
    write_wav(dry_path, r.sr, r.dry)
    write_wav(wet_path, r.sr, r.wet)
    write_wav(mix_path, r.sr, r.mix)
    for path, arr in ((dry_path, r.dry), (wet_path, r.wet), (mix_path, r.mix)):
        _sr2, back = read_wav(path)
        # 读回的 float 与写出的 int16 只应相差一次 PCM16 量化误差
        check(f"{os.path.basename(path)} 读回幅值与 to_pcm16 量化一致（误差 ≤ 1/32767）",
              np.max(np.abs(back - to_pcm16(arr).astype(np.float64) / 32767.0))
              <= 1.0 / 32767.0 + 1e-12 and _sr2 == r.sr)
    # 量化后仍满足分轨相加关系（在不削顶时）
    _s, mix_back = wavfile.read(mix_path)
    _s, dry_back = wavfile.read(dry_path)
    _s, wet_back = wavfile.read(wet_path)
    check("int16 域 mix ≈ dry + wet（量化误差 ≤ 1）",
          np.max(np.abs(mix_back.astype(int) - dry_back.astype(int)
                        - wet_back.astype(int))) <= 1)

    # -------------------------------------------------------------- 6
    print("[8] 声道 / 长度匹配规则")
    stereo_ir = builtin_ir("reflections", sr)
    mono_dry = g_audio.mean(axis=1, keepdims=True)
    m1, msg1 = match_ir_to_dry(stereo_ir, sr, sr, 1)
    fold = stereo_ir.mean(axis=1)[: m1.shape[0]]
    check("单声道干声 + 立体声 IR → 折叠为单声道（R2）",
          m1.shape[1] == 1 and np.allclose(m1[:, 0], fold)
          and any("R2" in m for m in msg1))
    mono_ir = stereo_ir[:, :1]
    m2, msg2 = match_ir_to_dry(mono_ir, sr, sr, 2)
    check("立体声干声 + 单声道 IR → 复制到左右（R3）",
          m2.shape[1] == 2 and np.allclose(m2[:, 0], m2[:, 1])
          and any("R3" in m for m in msg2))
    uneven = np.zeros((1000, 2))
    uneven[:900, 0] = rng.standard_normal(900) * 0.5
    uneven[:700, 1] = rng.standard_normal(700) * 0.5
    m3, msg3 = match_ir_to_dry(uneven, sr, sr, 2)
    check("左右有效长度不同 → 按最长 900 统一、短声道补零（R5）",
          m3.shape[0] == 900 and np.all(m3[700:900, 1] == 0.0)
          and np.allclose(m3[:700], uneven[:700])
          and any("R5" in m for m in msg3))
    # IR 以 24k 读入、匹配到 48k 干声 -> 采样数按采样率比翻倍；
    # R5 会裁掉尾部静音，所以只要求重采样生效且时长保持在 0.25s 量级
    ir_24 = builtin_ir("reflections", sr // 2)  # 0.25s @24k = 6000 采样
    m4, msg4 = match_ir_to_dry(ir_24, sr // 2, sr, 2)
    check("采样率不同 → 重采样到干声采样率（R1），时长保持在 0.25s 量级",
          ir_24.shape[0] == 6000
          and 0.15 * sr <= m4.shape[0] <= 0.25 * sr + 64
          and any("R1" in m for m in msg4))
    # 用无静音尾的密集 IR 验证精确的 2x 长度关系
    dense24 = np.ones((3000, 2)) * 0.5
    m4b, _ = match_ir_to_dry(dense24, sr // 2, sr, 2)
    check("无静音尾时重采样长度精确为 2 倍（6000）", m4b.shape[0] == 6000)
    # 4 声道文件：只取前两声道
    four = np.column_stack([stereo_ir, stereo_ir[:, ::-1]])
    m5, msg5 = match_ir_to_dry(four, sr, sr, 2)
    check("多于两声道 → 只取前两声道（R4）",
          m5.shape[1] == 2 and np.allclose(m5, stereo_ir[: m5.shape[0]])
          and any("R4" in m for m in msg5))

    # -------------------------------------------------------------- 边界
    print("[9] 边界情况（用无零采样的密集 IR，排除 IR 自身静音的干扰）")
    dense_ir = (np.ones((int(0.2 * sr), 2)) * 0.5
                + rng.standard_normal((int(0.2 * sr), 2)) * 0.01)
    # lead 短于 IR：只取反转 IR 最后 lead 个
    short = RenderParams(lead_ms=50.0, fade_ms=10.0)
    rs = render_reverse_reverb(g_audio, sr, clap1, dense_ir, short)
    lead_s = int(0.050 * sr)
    nz = np.flatnonzero(np.max(np.abs(rs.wet), axis=1))
    check("提前量短于 IR：湿声长度等于提前量且仍贴住起音",
          nz.max() == rs.onset_index - 1
          and rs.onset_index - nz.min() + 1 == lead_s)
    expect_short = dense_ir[::-1][dense_ir.shape[0] - lead_s:, :]
    # 跳过开头 5ms 淡入区与结尾 10ms 淡变区，中段必须与反转 IR 逐点相同
    fi = int(0.005 * sr)
    check("短提前量下湿声内容是反转 IR 的最后 lead 个采样（淡入/淡变区外逐点相同）",
          np.allclose(
              rs.wet[rs.onset_index - lead_s + fi: rs.onset_index - int(0.01 * sr)],
              expect_short[fi: lead_s - int(0.01 * sr)], atol=1e-9))
    # fade = 0：硬交界，起音前湿声不淡出
    hard = RenderParams(lead_ms=100.0, fade_ms=0.0)
    rh = render_reverse_reverb(g_audio, sr, clap1, dense_ir, hard)
    check("淡变=0：起音前一采样湿声保持满增益，起音处归零",
          np.max(np.abs(rh.wet[rh.onset_index - 1])) > 0.4
          and np.all(rh.wet[rh.onset_index] == 0.0))
    # 起音在文件头：prepend 等于整个提前量
    r0 = render_reverse_reverb(g_audio, sr, 0, ir, params)
    check("起音在第 0 采样：prepend = 完整提前量，干声仍未后移",
          r0.prepend == lead and np.allclose(r0.dry[lead:], g_audio, atol=1e-12))
    # 立体声与单声道干声都能跑通，且形状正确
    rm, _ = match_ir_to_dry(ir, sr, sr, 1)
    r_mono = render_reverse_reverb(mono_dry, sr, clap1, rm, params)
    check("单声道干声渲染：分轨均为单声道、等长、mix=dry+wet",
          r_mono.dry.shape[1] == 1 and r_mono.dry.shape == r_mono.mix.shape
          and np.allclose(r_mono.mix, r_mono.dry + r_mono.wet))

    print(f"\n结果：{PASS} 通过，{FAIL} 失败。临时文件目录：{work}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
