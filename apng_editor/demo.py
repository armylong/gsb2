"""Command-line demo: build the three samples, export and verify them.

Run ``python -m apng_editor.demo --output DIR`` to produce three APNG files
and a report.  The same three samples are loadable from the GUI's sample
drop-down, so this command doubles as a quick regression check.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .apng_codec import decode_apng
from .exporter import export_apng, verify_export
from .samples import SAMPLES


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="生成三组样例 APNG 并逐帧回读校验"
    )
    parser.add_argument(
        "--output",
        default="out",
        help="输出目录（默认 out）",
    )
    args = parser.parse_args(argv)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    failures = 0
    for name, factory in SAMPLES.items():
        project = factory()
        path = export_apng(project, output / f"{name}.png")
        report = verify_export(project, path)
        decoded = decode_apng(path)
        print(f"[{name}] -> {path}")
        print(
            f"  画布 {decoded.width}×{decoded.height}，"
            f"{len(decoded.frames)} 帧，"
            f"循环 {'无限' if decoded.loop_count == 0 else decoded.loop_count}"
        )
        for check in report.frames:
            mark = "OK" if check.pixels_match and check.duration_ok else "FAIL"
            print(
                f"  {mark} 第 {check.index + 1} 帧 "
                f"{check.expected_ms} ms（回读 {check.actual_ms:.3f} ms）"
                + (f"  {check.detail}" if check.detail else "")
            )
        if report.ok:
            print("  校验通过：逐像素与合成结果一致")
        else:
            failures += 1
            print(report.summary())

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
