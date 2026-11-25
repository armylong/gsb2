#!/usr/bin/env python3
"""Launch the local Light Trail Stacker desktop tool."""

from __future__ import annotations

import argparse
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="本地固定视角光迹堆叠工具")
    parser.add_argument(
        "--generate-sample",
        nargs="?",
        const="",
        default=None,
        metavar="DIR",
        help="生成内置匀速光点/闪光/停顿样例后退出；可选择性指定目录",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.generate_sample is not None:
        target = (
            Path(args.generate_sample).expanduser()
            if args.generate_sample
            else Path.cwd() / "generated_samples" / "uniform_point_flash_pause"
        )
        from lighttrails.synth import write_sample_sequence

        info = write_sample_sequence(target)
        print(f"sample_dir={info.folder}")
        print(f"files={len(info.paths)} missing_number={info.missing_number}")
        return 0

    from lighttrails.gui.main_window import main as gui_main

    return gui_main()


if __name__ == "__main__":
    raise SystemExit(main())
