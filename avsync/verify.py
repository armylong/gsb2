"""无界面验证：生成带已知偏移的样例 → 检测 → 修正导出 → 重新解码检测 → 报告误差。

用法：
    python -m avsync.verify                 # 默认 +350ms 与 -200ms 两组
    python -m avsync.verify --offset-ms 350 --keep
退出码：全部样例误差在容差内为 0，否则为 1。
"""
from __future__ import annotations

import argparse
import os
import tempfile

import numpy as np

from . import media

TOLERANCE_MS = 45.0  # 约 1 帧(40ms) + 检测量化余量


def run_case(offset_ms: float, workdir: str, keep: bool = False) -> bool:
    tag = f"offset_{offset_ms:+.0f}ms"
    src = os.path.join(workdir, f"sample_{tag}.mp4")
    out = os.path.join(workdir, f"corrected_{tag}.mp4")

    print(f"\n=== 样例：已知音轨偏移 {offset_ms:+.0f} ms ===")
    media.make_sample(src, offset_ms=offset_ms)
    print(f"样例: {src}")

    est = media.suggest_correction(src)
    corr = est["correction_s"]
    print(f"检测到 {len(est['pairs'])} 对标记，建议修正量 {corr * 1000:+.1f} ms"
          f"（期望 {-offset_ms:+.1f} ms）")

    # 与导出完全相同的规则
    head = "truncate" if corr < 0 else "pad"
    tail = "truncate" if corr > 0 else "pad"
    chain = media.build_audio_filter(corr, head, tail, media.DURATION)
    print(f"修正规则: head={head} tail={tail} 滤镜: {chain}")
    media.export(src, out, corr, head, tail)
    print(f"输出: {out}")

    # 重新解码输出，报告标记间误差
    res = media.suggest_correction(out)
    print(f"{'事件':>6} {'闪光帧t(s)':>12} {'蜂鸣t(s)':>12} {'误差(ms)':>10}")
    errs = []
    for i, (f, b, d) in enumerate(res["pairs"]):
        errs.append(d * 1000)
        print(f"{i:>6} {f:>12.3f} {b:>12.3f} {d * 1000:>+10.1f}")
    errs = np.array(errs)
    ok = bool(np.all(np.abs(errs) <= TOLERANCE_MS))
    print(f"最大|误差| {np.abs(errs).max():.1f} ms，均值 {errs.mean():+.1f} ms，"
          f"容差 ±{TOLERANCE_MS:.0f} ms -> {'PASS' if ok else 'FAIL'}")
    if not keep:
        for p in (src, out):
            if os.path.exists(p):
                os.unlink(p)
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="声画同步修正的端到端验证")
    ap.add_argument("--offset-ms", type=float, action="append",
                    help="样例音轨偏移（可多次指定），默认 +350 和 -200")
    ap.add_argument("--keep", action="store_true", help="保留生成的样例与输出文件")
    ap.add_argument("--workdir", default=None, help="工作目录（默认临时目录）")
    args = ap.parse_args()
    offsets = args.offset_ms or [350.0, -200.0]

    workdir = args.workdir or tempfile.mkdtemp(prefix="avsync_verify_")
    os.makedirs(workdir, exist_ok=True)
    print(f"工作目录: {workdir}")

    results = [run_case(off, workdir, keep=args.keep) for off in offsets]
    print("\n==== 汇总 ====")
    for off, ok in zip(offsets, results):
        print(f"  偏移 {off:+.0f} ms : {'PASS' if ok else 'FAIL'}")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
