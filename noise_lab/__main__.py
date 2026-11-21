"""入口:默认启动 GUI;`--selftest` 无界面自检并导出测量剖面与处理音轨。

用法:
  python -m noise_lab              # 启动 GUI
  python -m noise_lab --selftest [输出目录]   # 无界面验证
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np

from . import core


def selftest(out_dir: str | Path | None = None) -> int:
    out = Path(out_dir or tempfile.mkdtemp(prefix="noise_lab_selftest_"))
    out.mkdir(parents=True, exist_ok=True)
    sr = core.SR
    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = ""):
        checks.append((name, bool(ok), detail))
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}  {detail}")

    print("== 1. 稳定嗡声示例:基线分析 ==")
    x = core.generate_example("stable_hum", sr)
    # 手选 3 段无声片段(示例本身即纯底噪)
    segs = [(0.5, 2.5), (5.0, 7.0), (9.5, 11.5)]
    reps = [core.check_segment(x[int(a * sr):int(b * sr)], sr, i, a, b)
            for i, (a, b) in enumerate(segs)]
    base = core.build_baseline(reps)
    hum_freqs = [h["freq"] for h in base.hums]
    check("检出 50Hz 嗡声", any(abs(f - 50) < 3 for f in hum_freqs), f"hums={hum_freqs}")
    check("检出 150Hz 谐波", any(abs(f - 150) < 4 for f in hum_freqs))
    check("稳定示例波动小", base.overall_spread_db < 3.0,
          f"spread={base.overall_spread_db} dB")
    check("无误报漂移", not base.drift_detected)

    print("== 2. 缓慢漂移示例:首尾对比 ==")
    xd = core.generate_example("drifting", sr)
    reps_d = [core.check_segment(xd[int(a * sr):int(b * sr)], sr, i, a, b)
              for i, (a, b) in enumerate([(0.2, 2.2), (3.0, 5.0), (7.0, 9.0), (9.8, 11.8)])]
    base_d = core.build_baseline(reps_d)
    check("检出漂移", base_d.drift_detected,
          f"max|delta|={max(abs(d['delta_db']) for d in base_d.drift)} dB")

    print("== 3. 瞬态与过短警告 ==")
    xt = core.generate_example("transient", sr)
    rep_t = core.check_segment(xt[int(1.5 * sr):int(3.5 * sr)], sr, 0, 1.5, 3.5)
    check("瞬态被标记", any("瞬态" in w for w in rep_t.warnings), f"crest={rep_t.crest_db} dB")
    rep_short = core.check_segment(xt[:int(0.1 * sr)], sr, 1, 0.0, 0.1)
    check("过短片段被拒绝", not rep_short.accepted and any("过短" in w for w in rep_short.warnings))

    print("== 4. 窄音估计与减弱 ==")
    xs = core.generate_example("signal", sr)
    before = core.tone_power_db(xs, sr, 50.0)
    y, notches = core.reduce_tones(xs, sr)
    after = core.tone_power_db(y, sr, 50.0)
    check("自动估计到 50Hz", any(abs(f - 50) < 3 for f in notches), f"notches={notches}")
    check("50Hz 分量减弱 ≥20 dB", before - after >= 20, f"{before:.1f} → {after:.1f} dB")

    print("== 5. 导出测量剖面与处理音轨 ==")
    prof = out / "profile.json"
    base.to_json(prof, extra={
        "sample_rate": sr,
        "band_centers_hz": core.BAND_CENTERS.tolist(),
        "drifting_example": {"drift_detected": base_d.drift_detected, "drift": base_d.drift},
        "tone_reduction": {"notches_hz": notches,
                           "tone_50hz_before_db": round(before, 2),
                           "tone_50hz_after_db": round(after, 2)},
    })
    wav_out = out / "signal_denoised.wav"
    core.write_wav(wav_out, y, sr)
    back, sr2 = core.read_wav(wav_out)
    ok_files = prof.exists() and wav_out.exists() and sr2 == sr and len(back) == len(y)
    check("剖面 JSON 与处理音轨写出并可读回", ok_files, f"dir={out}")
    parsed = json.loads(prof.read_text())
    check("剖面内容完整", "baseline" in parsed and "tone_reduction" in parsed)

    n_fail = sum(1 for _, ok, _ in checks if not ok)
    print(f"\n自检完成: {len(checks) - n_fail}/{len(checks)} 通过,产物目录 {out}")
    return 1 if n_fail else 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--selftest" in argv:
        argv.remove("--selftest")
        return selftest(argv[0] if argv else None)
    from .app import run_gui
    return run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
