"""命令行接口：导出内置实验短片、核对导出包。

示例
====
python -m rolling_shutter.cli export fast --mode rolling -o /tmp/rs.zip
python -m rolling_shutter.cli verify /tmp/rs.zip
"""
from __future__ import annotations

import argparse
import json
import sys

from .export import export_clip, verify_export
from .model import MODE_GLOBAL, MODE_ROLLING, render_clip
from .presets import PRESETS


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="滚动快门合成模拟 CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_exp = sub.add_parser("export", help="导出内置实验的一组短片")
    p_exp.add_argument("preset",
                       choices=sorted(set(PRESETS) | {"fast"}),
                       help="fast/fast_motion=快移实验, flash=闪光实验")
    p_exp.add_argument("--mode", choices=[MODE_GLOBAL, MODE_ROLLING],
                       default=MODE_ROLLING)
    p_exp.add_argument("-o", "--output", required=True, help="输出 zip 路径")

    p_ver = sub.add_parser("verify", help="核对导出包的时间与尺寸")
    p_ver.add_argument("path")

    args = parser.parse_args(argv)
    if args.cmd == "export":
        preset_key = "fast_motion" if args.preset == "fast" else args.preset
        params = PRESETS[preset_key][1]()
        clip = render_clip(params, args.mode)
        path = export_clip(clip, args.output)
        report = verify_export(path)
        print(json.dumps({"exported": str(path), "signature": clip.signature,
                          "verify_ok": report["ok"]},
                         ensure_ascii=False, indent=2))
        return 0 if report["ok"] else 1
    report = verify_export(args.path)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
