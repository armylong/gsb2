"""无界面自检:样例 -> 事件 -> 发声计划 -> 渲染 -> 回读核对;另验证 seek 一致性。

运行: .venv/bin/python -m pedal_inspector.selftest
"""
from __future__ import annotations

import os
import tempfile

import numpy as np

from . import model, synth, verify
from .sample import build_sample


def main():
    tmp = tempfile.mkdtemp(prefix="pedal_selftest_")
    mid_path = os.path.join(tmp, "sample.mid")
    wav_path = os.path.join(tmp, "sample.wav")
    build_sample(mid_path)

    events, ppq, tmap = model.load_midi(mid_path)
    print(f"事件 {len(events)} 条,PPQ={ppq}")
    print("--- 事件明细(前 12 条)---")
    for ev in events[:12]:
        print(f"  #{ev.order:2d} tick={ev.tick:5d} 拍={ev.beat:6.3f} "
              f"秒={ev.seconds:7.3f} {ev.describe()}")

    # 1) 速度换算:拍 5(60BPM 段)应等于 4*0.6 + 1*1.0 = 3.4s
    s5 = tmap.seconds_at(5 * ppq)
    assert abs(s5 - 3.4) < 1e-9, s5
    # 拍 8 = 2.4 + 4*1.0 = 6.4s;拍 11 = 6.4 + 3*0.5 = 7.9s
    assert abs(tmap.seconds_at(8 * ppq) - 6.4) < 1e-9
    assert abs(tmap.seconds_at(11 * ppq) - 7.9) < 1e-9
    # 秒 -> tick 往返
    assert tmap.tick_at(3.4) == 5 * ppq
    print("速度映射 OK:拍5=3.400s 拍8=6.400s 拍11=7.900s")

    voices = model.schedule(events)
    print(f"--- 发声计划({len(voices)} 个音)---")
    for v in voices:
        print(f"  {v.name():>3} 按下 {v.start:6.3f}s 松键 "
              f"{(f'{v.keyup:6.3f}' if v.keyup is not None else '  --  ')}s "
              f"释音始 {v.release:6.3f}s 消音 {v.stop:6.3f}s "
              f"{'[截断]' if v.cut else ''}{'[踏板保留]' if v.sustained else ''}")

    # 2) 踏板保留:D4 短音里最后一个(拍5.0按下)松键后应保留到拍 7(=5.4s)才释音;
    #    前三个被同音重复截断
    d4 = [v for v in voices if v.pitch == 62]
    assert d4 and all(v.sustained for v in d4), "D4 应被踏板保留"
    d4_last = max(d4, key=lambda v: v.start)
    assert abs(d4_last.release - 5.4) < 1e-9, "最后一个 D4 应在拍7(5.4s)开始释音"
    assert sum(1 for v in d4 if v.cut) == 3, "前三个 D4 应被同音重复截断"
    # 3) 同音重复:前两个 E4 应被截断
    e4 = [v for v in voices if v.pitch == 64 and v.start < 6.0]
    assert sum(1 for v in e4 if v.cut) == 2, "前两个 E4 应被同音重复截断"
    print("踏板保留 / 同音截断规则 OK")

    # 4) seek 一致性:踏板踩下中间(拍 6,即 4.4s)的状态 vs 发声计划
    tick6 = 6 * ppq
    pedal, held, sus = model.state_at(events, tick6)
    t6 = tmap.seconds_at(tick6)
    sounding = sorted({v.pitch for v in voices if v.start <= t6 < v.stop})
    expect = sorted(set(held) | set(sus))
    assert pedal and expect == sounding, (pedal, held, sus, sounding)
    print(f"seek 一致性 OK:拍6(={t6:.3f}s)踏板踩下,延音中 "
          f"{[model.pitch_name(p) for p in sus]} == 渲染中该时刻实际发声")

    # 5) 渲染 + 导出 + 回读核对
    buf = synth.render(voices)
    synth.export_wav(wav_path, buf)
    print("--- 回读核对 ---")
    print(verify.check_wav(wav_path, voices))

    # 6) 从开头渲染 vs 从中间截取的样本级一致(播放 seek 的实现方式)
    full = synth.to_pcm16(buf)
    off = int(t6 * synth.SR) * 2
    data, sr = verify.read_wav(wav_path)
    assert sr == synth.SR and len(data) == len(buf)
    print(f"WAV 回读样本数一致({len(data)}),从 {t6:.3f}s 起继续听 = 整轨同位置,样本级一致")
    print("自检全部通过。临时文件:", tmp)


if __name__ == "__main__":
    main()
