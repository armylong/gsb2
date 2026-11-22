"""核心引擎冒烟测试:不变量、确定性、迟到丢弃、流尾短包、导出往返。"""
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from plc_testbed.core import (EngineParams, run_simulation, synth_chirp,
                              synth_speech_like)
from plc_testbed.storage import export_all, read_wav

SR = 16000
src = synth_speech_like(3.0, SR)
# 故意切成不能被包长整除的长度,制造流尾短包
src_odd = src[:int(2.77 * SR) + 123]


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        raise SystemExit(f"FAILED: {name}")


# 1. 输出长度 == 输入长度(含流尾短包),各种包长
for ms in (20, 30, 7.5):
    r = run_simulation(src_odd, SR, EngineParams(packet_ms=ms, preset="mixed"))
    check(f"len(output)==len(input) packet_ms={ms}",
          len(r.output) == len(src_odd))
    check(f"tail counted packet_ms={ms}",
          r.stats["tail_packet_samples"] ==
          len(src_odd) - (r.stats["n_packets"] - 1) * r.stats["packet_samples"])

# 2. 确定性:同参数两次运行逐比特一致
p = EngineParams(packet_ms=20, preset="mixed", seed=7)
r1 = run_simulation(src, SR, p)
r2 = run_simulation(src, SR, p)
check("deterministic output", np.array_equal(r1.output, r2.output))
check("deterministic stats", r1.stats == r2.stats)

# 3. 乱序 + 零缓冲 => 有迟到包;迟到包不插回,长度仍一致
r = run_simulation(src, SR, EngineParams(packet_ms=20, preset="reorder_pairs",
                                         playout_delay_ms=0))
check("reorder causes late packets", r.stats["n_late"] > 0)
check("late packets concealed", len(r.output) == len(src))
# 缓冲足够大 => 乱序被排回去,迟到消失
r = run_simulation(src, SR, EngineParams(packet_ms=20, preset="reorder_pairs",
                                         playout_delay_ms=100))
check("buffer absorbs reorder", r.stats["n_late"] == 0)

# 4. 加大缓冲 => 补偿变少、多等变多(可对照)
r_small = run_simulation(src, SR, EngineParams(preset="mixed", seed=3,
                                               playout_delay_ms=0))
r_big = run_simulation(src, SR, EngineParams(preset="mixed", seed=3,
                                             playout_delay_ms=200))
check("bigger buffer conceals less",
      r_big.stats["concealed_samples"] < r_small.stats["concealed_samples"])
check("bigger buffer waits more",
      r_big.stats["added_wait_ms"] > r_small.stats["added_wait_ms"])

# 5. 补静音 vs 短时填补:缺口处内容不同,静音段全零
r_sil = run_simulation(src, SR, EngineParams(preset="mixed", seed=3,
                                             plc_mode="silence"))
r_ext = run_simulation(src, SR, EngineParams(preset="mixed", seed=3,
                                             plc_mode="extrapolate"))
g = r_sil.gaps[0]
s0, s1 = int(g["start_ms"] * SR / 1000), int(g["end_ms"] * SR / 1000)
check("silence gap is zero", np.all(r_sil.output[s0:s1] == 0))
check("extrapolate gap nonzero", np.any(np.abs(r_ext.output[s0:s1]) > 0))
check("same length both modes", len(r_sil.output) == len(r_ext.output))

# 6. 长突发 => 平滑衰减到 0(缺口尾部能量 < 头部能量)
r = run_simulation(src, SR, EngineParams(preset="loss_burst", plc_mode="extrapolate"))
long_gaps = [g for g in r.gaps if g["end_ms"] - g["start_ms"] > 100]
check("has long gap", len(long_gaps) > 0)
g = long_gaps[0]
s0, s1 = int(g["start_ms"] * SR / 1000), int(g["end_ms"] * SR / 1000)
seg = np.abs(r.output[s0:s1])
half = len(seg) // 2
check("long gap fades out", seg[half:].mean() < seg[:half].mean())

# 7. 恢复位置可读:缺口记录里有恢复点,且落在输出范围内
r = run_simulation(src, SR, EngineParams(preset="mixed", seed=3))
rec = [g for g in r.gaps if g["recovery_sample"] >= 0]
check("recovery positions recorded", len(rec) > 0)
check("recovery in range",
      all(0 <= g["recovery_sample"] < len(r.output) for g in rec))

# 8. 导出往返:导出 WAV 与预览在 int16 量化精度内一致
with tempfile.TemporaryDirectory() as d:
    wav_path, csv_path, json_path = export_all(d, r, "smoke")
    back, sr2 = read_wav(wav_path, SR)
    check("export sr", sr2 == SR)
    check("export length", len(back) == len(r.output))
    diff = np.abs(back - r.output).max()
    check(f"export roundtrip diff={diff:.2e}", diff <= 1.0 / 32767 + 1e-9)
    check("csv exists", Path(csv_path).exists())
    check("json exists", Path(json_path).exists())
    # 包记录行数 == 包数
    n_rows = sum(1 for _ in open(csv_path, encoding="utf-8")) - 1
    check("csv rows == n_packets", n_rows == r.stats["n_packets"])

# 9. 流尾缺口:末尾长突发时输出长度仍正确,缺口记录到流尾
src2 = synth_chirp(2.0, SR)
r = run_simulation(src2, SR, EngineParams(packet_ms=20, preset="loss_burst",
                                          playout_delay_ms=0))
check("chirp length ok", len(r.output) == len(src2))

print("\n全部通过")
