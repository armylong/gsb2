from __future__ import annotations

import argparse

from .edits import format_offset
from .media import probe_file


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="列出 MKV 的流、语言、标题和标记")
    parser.add_argument("path", help="MKV 文件路径")
    return parser


def inspect_main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    info = probe_file(args.path)
    ref = info.reference_start()
    print(f"文件：{info.path}")
    if ref is not None:
        print(f"参考起点（主视频或最早流）：{ref:.3f}s")
    print("idx  out-kind  codec      lang   D F  offset    title")
    for s in info.streams:
        offset = info.relative_offset(s)
        print(
            f"{s.index:>3}  {s.codec_type:<8}  {s.codec_name:<10} "
            f"{(s.language or '∅'):<6} {int(s.default)} {int(s.forced)}  "
            f"{format_offset(offset):<8}  {s.title}"
        )
    return 0


def main(argv: list[str] | None = None) -> int:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] == "inspect":
        return inspect_main(args[1:])
    return inspect_main(args)


if __name__ == "__main__":
    raise SystemExit(main())
