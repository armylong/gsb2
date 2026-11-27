"""命令行入口：本地核对与生成样本都能不开 GUI 完成。

    python -m grayview sample --out samples
    python -m grayview info   --file F --width W --height H --skip S --gap G --bpp B
    python -m grayview pixel  --file F ... --row R --col C
    python -m grayview export --file F ... --out DIR --stem S [--missing mask --fill 0]
    python -m grayview verify --png P [--params J]
    python -m grayview gui    --file F ...
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .decode import decode
from .export import ExportError, export, verify_export
from .inspect import coverage, describe_pixel
from .layout import Interpretation, Layout, ParamError
from .samples import write_all


def _add_params(p: argparse.ArgumentParser, *, required: bool = True) -> None:
    p.add_argument("--file", "-f", required=required, help="原始灰度数据文件")
    p.add_argument("--width", type=int, required=required, help="图像宽（像素）")
    p.add_argument("--height", type=int, required=required, help="图像高（行）")
    p.add_argument("--skip", type=int, default=0, help="文件开头跳过的字节数")
    p.add_argument("--gap", type=int, default=0, help="行间空白字节数")
    p.add_argument(
        "--bpp", type=int, default=8, choices=(8, 12, 16),
        help="每像素位数：8=每像素1字节，16=小端2字节，12=每行从最低位连续打包",
    )


def _interp(args) -> Interpretation:
    return Interpretation(
        width=args.width, height=args.height, skip=args.skip, row_gap=args.gap, bpp=args.bpp
    )


def _load(args) -> tuple[bytes, Interpretation, object]:
    data = Path(args.file).read_bytes()
    interp = _interp(args)
    return data, interp, decode(data, interp)


def cmd_sample(args) -> int:
    out = Path(args.out)
    samples = write_all(out)
    print(f"已生成 {len(samples)} 个样本到 {out.resolve()}：")
    for s in samples:
        print(f"  {s.path.name}  {s.file_bytes} B  参数={s.interp.as_dict()}")
        print(f"    {s.note}")
    print(f"清单：{(out / 'manifest.json').resolve()}")
    return 0


def cmd_info(args) -> int:
    data, interp, dec = _load(args)
    print(f"文件 {Path(args.file).resolve()}  {len(data)} B")
    for line in interp.summary_lines():
        print("  " + line)
    print(f"文件大小  实际 {len(data)} B / 需要 {interp.required_bytes} B")
    cov = coverage(dec)
    for line in cov.note_lines:
        print("  " + line)
    lay = dec.layout
    print(
        f"有效像素 {int(dec.valid.sum())} / {dec.width * dec.height}，"
        f"缺失 {dec.missing_count}"
    )
    print("行布局（row  start  tail  present/row_bytes  status）：")
    for rl in lay.rows:
        print(
            f"  {rl.row:4d}  0x{rl.start:08X}  0x{rl.tail:08X}  "
            f"{rl.available}/{rl.row_bytes:4d}  {rl.status_label()}"
        )
    return 0


def cmd_pixel(args) -> int:
    data, interp, dec = _load(args)
    report = describe_pixel(dec, data, args.row, args.col)
    print(f"像素 ({report.row}, {report.col})")
    print(f"  灰度值   {report.value if report.valid else '未知（缺失）'}"
          f"  {report.value_hex if report.valid else ''}")
    print(f"  每像素   {report.bpp} 位")
    print(f"  取文件   {report.needed_bytes_text()}")
    actual = report.present_bytes
    print(f"  实有字节 {', '.join(f'0x{b:08X}' for b in actual) if actual else '无'}")
    if report.missing_bytes:
        print(f"  缺失字节 {', '.join(f'0x{b:08X}' for b in report.missing_bytes)}")
    print(f"  所在行   头 0x{report.row_start:08X} 尾 0x{report.row_tail:08X}")
    print("  取位：")
    for line in report.parts_text(data):
        print("    " + line)
    return 0


def cmd_export(args) -> int:
    data, interp, dec = _load(args)
    try:
        result = export(
            dec,
            args.out,
            stem=args.stem,
            bit_depth=args.export_bit,
            missing_policy=args.missing,
            fill_value=args.fill,
            source_path=args.file,
        )
    except ExportError as exc:
        print(f"导出失败：{exc}", file=sys.stderr)
        return 2
    print(f"PNG   {result.png_path}  ({result.bit_depth} 位)")
    if result.mask_path:
        print(f"掩膜  {result.mask_path}")
    print(f"参数  {result.params_path}")
    print(f"缺失  {result.missing_pixels} 像素，策略 {result.policy}")
    return 0


def cmd_verify(args) -> int:
    try:
        vr = verify_export(args.png, args.params, sample=args.sample)
    except (ExportError, OSError) as exc:
        print(f"核对失败：{exc}", file=sys.stderr)
        return 2
    print(vr.summary())
    for n in vr.notes:
        print("  注意：" + n)
    return 0 if vr.ok else 1


def cmd_gui(args) -> int:
    from .gui.main import run

    return run(file=args.file, params=_interp(args) if args.file else None)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="grayview", description="原始灰度数据读图 / 错位排查")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sample", help="生成自带样本")
    s.add_argument("--out", default="samples", help="输出目录")
    s.set_defaults(func=cmd_sample)

    s = sub.add_parser("info", help="显示文件大小、行布局、缺失与多余字节")
    _add_params(s)
    s.set_defaults(func=cmd_info)

    s = sub.add_parser("pixel", help="打印指定像素的灰度与取字节/取位")
    _add_params(s)
    s.add_argument("--row", type=int, required=True)
    s.add_argument("--col", type=int, required=True)
    s.set_defaults(func=cmd_pixel)

    s = sub.add_parser("export", help="导出灰度 PNG + 参数 + 缺失掩膜")
    _add_params(s)
    s.add_argument("--out", required=True, help="输出目录")
    s.add_argument("--stem", default="gray", help="输出文件名（不含扩展名）")
    s.add_argument("--export-bit", type=int, choices=(8, 16), default=None,
                   help="PNG 位深；默认 8 位数据用 8，12/16 位数据用 16")
    s.add_argument("--missing", choices=("mask", "fill", "none"), default=None,
                   help="有缺失时的策略；有缺失且不给会拒绝导出")
    s.add_argument("--fill", type=int, default=0, help="缺失像素写入的填充值")
    s.set_defaults(func=cmd_export)

    s = sub.add_parser("verify", help="重开导出的 PNG 并核对像素")
    s.add_argument("--png", required=True)
    s.add_argument("--params", default=None, help="参数 JSON；默认找同名 .params.json")
    s.add_argument("--sample", type=int, default=0, help="随机抽检 N 个像素，0=全图")
    s.set_defaults(func=cmd_verify)

    s = sub.add_parser("gui", help="打开读图窗口（需 PySide6）")
    _add_params(s, required=False)
    s.set_defaults(func=cmd_gui)
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except ParamError as exc:
        print(f"参数错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
