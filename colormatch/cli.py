"""命令行入口。

  python -m colormatch demo      生成样例工程并跑完整无 GUI 验证
  python -m colormatch generate  只生成样例工程
  python -m colormatch run       对已有工程做无 GUI 拟合与导出
  python -m colormatch gui       启动图形界面
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import __version__
from .samples import generate_sample_project
from .pipeline import run_headless


def _print_report(reports) -> None:
    for rep in reports:
        print(f"\n=== 源图 {rep.source_name} ({rep.source_id}) ===")
        print(f"模型: {rep.fit.method}  采样数: {rep.fit.n_samples}  "
              f"白点锁定: {'是(' + str(rep.fit.white_sample_id) + ')' if rep.fit.white_locked else '否'}")
        print(f"拟合残差 RMS: {rep.fit.residual_rms:.3f} /255   条件数: {rep.fit.condition_number:.2e}")
        print(f"平均色差 dE00: 处理前 {rep.mean_delta_e_before:.2f} -> 处理后 {rep.mean_delta_e_after:.2f}   "
              f"处理后最大 dE00: {rep.max_delta_e_after:.2f}")
        g = rep.gamut
        fg = g.get("foreground", g)
        print(f"越界像素（有效内容口径）: {fg['n_out']}/{fg['n_pixels']} "
              f"({100 * fg['out_of_gamut_fraction']:.2f}%)；全图口径: "
              f"{100 * g['out_of_gamut_fraction']:.2f}%")
        ch_names = ("R", "G", "B")
        for c, ch in enumerate(fg["per_channel"]):
            if ch["under"] or ch["over"]:
                print(f"  通道 {ch_names[c]}: 欠 {100 * ch['under']:.2f}%  过 {100 * ch['over']:.2f}%")
        print("各色块 dE00（处理前 -> 处理后）:")
        for e in rep.errors:
            flag = " *" if e.delta_e_after > 2.0 else ""
            print(f"  {e.sample_name:<6} {e.delta_e_before:6.2f} -> {e.delta_e_after:6.2f}{flag}")
        if rep.export_path:
            print(f"已导出: {rep.export_path}")
        for w in rep.fit.warnings:
            print(f"[警告] {w}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="colormatch", description="只关心颜色一致性的本地校色工具")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_demo = sub.add_parser("demo", help="生成样例工程并执行完整无 GUI 验证")
    p_demo.add_argument("--out", default="demo_output", help="输出目录（需为空，默认 ./demo_output）")
    p_demo.add_argument("--no-export", action="store_true", help="只计算不导出文件")

    p_gen = sub.add_parser("generate", help="生成样例图与预填采样的工程文件")
    p_gen.add_argument("--out", default="demo_output", help="输出目录（需为空）")

    p_run = sub.add_parser("run", help="对已有工程做无 GUI 拟合、对比和导出")
    p_run.add_argument("project", help="project.json 路径")
    p_run.add_argument("--export-dir", default=None, help="导出目录，默认与工程同目录")

    sub.add_parser("gui", help="启动图形界面")

    args = parser.parse_args(argv)

    if args.cmd == "gui":
        from .gui.app import run_gui

        return run_gui()

    if args.cmd in ("demo", "generate"):
        out = os.path.abspath(args.out)
        project_path = generate_sample_project(out)
        print(f"样例工程已生成: {project_path}")
        if args.cmd == "generate":
            return 0
        export_dir = None if args.no_export else os.path.join(out, "exports")
    else:
        project_path = os.path.abspath(args.project)
        export_dir = os.path.abspath(args.export_dir) if args.export_dir else os.path.join(
            os.path.dirname(project_path), "exports"
        )

    reports = run_headless(project_path, export_dir)
    _print_report(reports)

    # 验证断言：处理后平均色差必须显著下降且足够小
    ok = True
    for rep in reports:
        if not (rep.mean_delta_e_after < rep.mean_delta_e_before and rep.mean_delta_e_after < 1.5):
            ok = False
    print("\n验证结论:", "通过 ✓" if ok else "未通过 ✗")
    print(f"工程已更新（含拟合参数与采样位置）: {project_path}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
