"""关键行为自动验证（无需启动服务器，直接检查采样数据）。

用法: python3 verify.py [样例目录]
检查项:
  1. VAD 检出区间与已知区间吻合，且不会把整条旁白当作语音
  2. 提前压低: 语音开始时已压到目标值，提前量之外不受影响
  3. 短停顿合并保持压低；长空白中间恢复到接近原始音量
  4. 开头即说话 / 结尾仍说话 的边界情形
  5. 增益曲线逐样本平滑（无爆音式突跳）
  6. 导出 wav 重载后: 采样率/时长(<=1 采样误差)/采样值与处理结果一致
  7. 旁白不被压低；峰值保护触发时最终峰值 <= 上限
  8. 处理结果确定性（同参数两次处理逐位一致 = 试听与导出同源）
"""
import json
import os
import sys
import tempfile

import numpy as np

import duckcore as dc

FAILED = []


def check(name, cond, detail=''):
    mark = 'PASS' if cond else 'FAIL'
    print(f'[{mark}] {name}' + (f'  {detail}' if detail else ''))
    if not cond:
        FAILED.append(name)


def gain_at(gain, sr, t):
    i = max(0, min(len(gain) - 1, int(round(t * sr))))
    return gain[i]


def main():
    sdir = sys.argv[1] if len(sys.argv) > 1 else 'samples'
    narration, sr = dc.load_wav(os.path.join(sdir, 'narration.wav'))
    music, sr_m = dc.load_wav(os.path.join(sdir, 'music.wav'))
    narration = dc.to_mono(narration)
    music = dc.to_stereo(music)
    known = json.load(open(os.path.join(sdir, 'known_segments.json')))['segments']
    n = len(narration)
    dur = n / sr

    check('旁白为单声道且 <= 30s', narration.ndim == 1 and dur <= 30.0,
          f'{dur:.2f}s @ {sr}Hz')
    check('音乐为立体声且不短于旁白', music.ndim == 2 and len(music) >= n,
          f'{len(music)/sr_m:.2f}s')

    # 1. VAD
    segs = dc.detect_speech(narration, sr)
    check('VAD 段数与已知一致', len(segs) == len(known),
          f'检出 {len(segs)} 段, 已知 {len(known)} 段')
    covered = sum(e - s for s, e in segs)
    check('VAD 未把整条当作语音', covered < 0.8 * dur,
          f'语音占比 {covered/dur:.0%}')
    if len(segs) == len(known):
        errs = [max(abs(s - ks), abs(e - ke))
                for (s, e), (ks, ke) in zip(segs, known)]
        check('VAD 边界误差 < 0.25s', max(errs) < 0.25,
              f'最大误差 {max(errs)*1000:.0f}ms')

    # 2/3. 增益曲线行为
    p = dict(dc.DEFAULTS)
    merged = dc.merge_segments(segs, p['merge_gap_ms'] / 1000.0)
    gain = dc.build_gain_curve(n, sr, merged, p['duck_db'],
                               p['lookahead_ms'], p['release_ms'])
    duck = 10 ** (p['duck_db'] / 20)
    s0, e0 = merged[0]
    check('语音开始处已压到目标值', abs(gain_at(gain, sr, s0) - duck) < 0.02,
          f'gain={gain_at(gain, sr, s0):.3f} 目标 {duck:.3f}')
    look = p['lookahead_ms'] / 1000.0
    check('提前量之外不受影响', gain_at(gain, sr, s0 - look - 0.3) > 0.99,
          f'gain={gain_at(gain, sr, s0 - look - 0.3):.3f}')
    check('提前量中点正在下降',
          duck < gain_at(gain, sr, s0 - look / 2) < 0.99,
          f'gain={gain_at(gain, sr, s0 - look/2):.3f}')

    # 短停顿（已知区间 0-1、1-2 之间 0.4s）应保持压低
    gap1_mid = (known[0][1] + known[1][0]) / 2
    check('短停顿中保持压低', gain_at(gain, sr, gap1_mid) < duck + 0.05,
          f'gain={gain_at(gain, sr, gap1_mid):.3f}')
    # 长空白（第 3 段前 3.0s）中间应恢复
    gap2_mid = (known[2][1] + known[3][0]) / 2
    check('长空白中间恢复', gain_at(gain, sr, gap2_mid) > 0.95,
          f'gain={gain_at(gain, sr, gap2_mid):.3f}')

    # 4. 边界情形：开头即说话、结尾仍说话
    g_edge = dc.build_gain_curve(n, sr, [(0.0, 2.0), (dur - 2.0, dur)],
                                 -12.0, 300.0, 600.0)
    check('开头即说话: 曲线起点即全压', abs(g_edge[0] - duck) < 0.02,
          f'gain[0]={g_edge[0]:.3f}')
    check('结尾仍说话: 曲线终点保持全压', abs(g_edge[-1] - duck) < 0.02,
          f'gain[-1]={g_edge[-1]:.3f}')

    # 5. 平滑性：相邻样本增益变化远小于 1ms 全幅变化
    max_step = float(np.max(np.abs(np.diff(gain)))) if n > 1 else 0
    check('增益曲线平滑无突跳', max_step < 2.0 / (0.005 * sr),
          f'最大单样本变化 {max_step:.2e}')

    # 6. 处理 + 导出 + 重载核对
    r = dc.process(music, narration, sr, segs, p)
    check('输出长度 == 旁白长度', r['n_samples'] == n,
          f'{r["n_samples"]} 采样')
    with tempfile.TemporaryDirectory() as td:
        out_path = os.path.join(td, 'mix.wav')
        dc.write_wav(out_path, r['out'], sr)
        back, sr_b = dc.load_wav(out_path)
        back = dc.to_stereo(back)
        check('导出重载: 采样率一致', sr_b == sr, f'{sr_b}Hz')
        check('导出重载: 时长误差 <= 1 采样', abs(len(back) - n) <= 1,
              f'差 {abs(len(back)-n)} 采样')
        ref_q = (np.clip(r['out'], -1, 1) * 32767).round().astype(np.int16)
        back_q = (np.clip(back[:n], -1, 1) * 32767).round().astype(np.int16)
        err = int(np.max(np.abs(ref_q.astype(np.int32)
                                - back_q.astype(np.int32))))
        check('导出重载: 采样值一致 (<=1 LSB)', err <= 1,
              f'最大误差 {err} LSB')

        # 7. 旁白未被压低: 导出 - 音乐*增益*保护 == 旁白*保护
        protect = 10 ** (r['protection_gain_db'] / 20)
        music_n = music[:n].astype(np.float64)
        narr_part = (back[:n].astype(np.float64)
                     - music_n * r['gain'][:, None] * protect)
        narr_ref = narration[:n].astype(np.float64)[:, None] * protect
        lsb = 2.0 / 32767
        narr_err = float(np.max(np.abs(narr_part - narr_ref)))
        check('旁白未被音乐闪避影响', narr_err < 3 * lsb,
              f'最大偏差 {narr_err:.2e}')

    check('峰值保护上限有效', r['final_peak'] <= dc.CEILING + 1e-6,
          f'最终峰值 {r["final_peak"]:.4f} (上限 {dc.CEILING})')
    print(f'      保护触发: {r["protection_triggered"]}, '
          f'叠加峰值 {r["peak"]:.3f}, 最终 {r["final_peak_db"]:.1f} dBFS')

    # 8. 确定性（试听与导出同源）
    r2 = dc.process(music, narration, sr, segs, p)
    check('同参数处理结果逐位一致',
          np.array_equal(r['out'], r2['out'])
          and np.array_equal(r['gain'], r2['gain']))

    # 强制触发峰值保护的情形
    loud_narr = np.clip(narration * 4.0, -1, 1)
    r3 = dc.process(music, loud_narr, sr, segs, p)
    check('过载时峰值保护触发', r3['protection_triggered'],
          f'叠加峰值 {r3["peak"]:.3f}')
    check('保护后峰值 <= 上限', r3['final_peak'] <= dc.CEILING + 1e-6,
          f'{r3["final_peak"]:.4f}')

    print()
    if FAILED:
        print(f'{len(FAILED)} 项失败: {FAILED}')
        sys.exit(1)
    print('全部通过 ✔')


if __name__ == '__main__':
    main()
