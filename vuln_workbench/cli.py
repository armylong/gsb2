"""命令行入口:

    python -m vuln_workbench serve [--port 8765]
    python -m vuln_workbench import <工程文件> <复现包路径> [<更多包>...]
    python -m vuln_workbench compare <工程文件> <包A> <包B>
    python -m vuln_workbench export <工程文件> <导出文件.json|.md>
    python -m vuln_workbench info <工程文件>

所有命令都是纯本地静态操作, 不发起网络请求、不执行导入内容。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .diff import compare_packages
from .export import export_project, render_markdown
from .importer import ImportFatalError, import_package
from .project import ProjectLoadError, load_project, new_project, save_project


def _open_or_create(project_path: Path):
    if project_path.exists():
        return load_project(project_path)
    project = new_project(project_path.stem)
    return project


def cmd_import(args) -> int:
    try:
        project = _open_or_create(Path(args.project))
    except ProjectLoadError as exc:
        print(f"[错误] 工程无法打开, 已中止, 当前文件未被修改: {exc}",
              file=sys.stderr)
        return 2
    for pkg_path in args.packages:
        try:
            report = import_package(project, pkg_path)
        except ImportFatalError as exc:
            print(f"[错误] 复现包 {pkg_path} 无法读取, 工程保持不变: {exc}",
                  file=sys.stderr)
            save_project(project, args.project)
            return 2
        print(f"[OK] {report.package.name}: {len(report.items)} 个文件, "
              f"{len(report.duplicates)} 个重复证据")
        for item in report.items:
            for w in item.warnings:
                print(f"  - {item.file.rel_path}: {w}")
    save_project(project, args.project)
    print(f"[OK] 工程已保存: {args.project}")
    return 0


def cmd_compare(args) -> int:
    project = load_project(Path(args.project))
    pkg_a = next((p for p in project.packages if p.name == args.package_a
                  or p.id == args.package_a or p.source_path == args.package_a),
                 None)
    pkg_b = next((p for p in project.packages if p.name == args.package_b
                  or p.id == args.package_b or p.source_path == args.package_b),
                 None)
    if pkg_a is None or pkg_b is None:
        print("[错误] 指定的包不存在于工程中", file=sys.stderr)
        return 2
    files_a = [f for f in project.files if f.package_id == pkg_a.id]
    files_b = [f for f in project.files if f.package_id == pkg_b.id]
    result = compare_packages(files_a, files_b)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_export(args) -> int:
    project = load_project(Path(args.project))
    exported, pending = export_project(project)
    out = Path(args.output)
    if out.suffix.lower() in (".md", ".markdown"):
        out.write_text(render_markdown(exported), encoding="utf-8")
    else:
        out.write_text(json.dumps(exported, ensure_ascii=False, indent=2),
                       encoding="utf-8")
    print(f"[OK] 已脱敏导出 {out} (待脱敏项 {len(pending)} 类, "
          f"共 {sum(p['count'] for p in pending)} 处)")
    return 0


def cmd_info(args) -> int:
    project = load_project(Path(args.project))
    print(f"工程: {project.name} ({project.id})")
    print(f"包: {len(project.packages)}  文件: {len(project.files)}  "
          f"关联组: {len(project.correlations)}  标注: {len(project.annotations)}")
    dup = [f for f in project.files if f.duplicate_of]
    print(f"重复证据: {len(dup)} 份")
    print(f"操作记录: {len(project.operations)} 条")
    return 0


def cmd_serve(args) -> int:
    from .server import serve
    serve(host="127.0.0.1", port=args.port)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m vuln_workbench",
        description="本地漏洞复现证据工作台 (纯静态, 无网络出站)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_serve = sub.add_parser("serve", help="启动本机 Web 工作台")
    p_serve.add_argument("--port", type=int, default=8765)
    p_serve.set_defaults(func=cmd_serve)

    p_import = sub.add_parser("import", help="导入一个或多个复现包")
    p_import.add_argument("project", help="工程文件路径 (不存在则创建)")
    p_import.add_argument("packages", nargs="+", help="复现包目录或 zip")
    p_import.set_defaults(func=cmd_import)

    p_cmp = sub.add_parser("compare", help="比较工程内两个复现包")
    p_cmp.add_argument("project")
    p_cmp.add_argument("package_a")
    p_cmp.add_argument("package_b")
    p_cmp.set_defaults(func=cmd_compare)

    p_exp = sub.add_parser("export", help="脱敏导出工程 (.json/.md)")
    p_exp.add_argument("project")
    p_exp.add_argument("output")
    p_exp.set_defaults(func=cmd_export)

    p_info = sub.add_parser("info", help="查看工程摘要")
    p_info.add_argument("project")
    p_info.set_defaults(func=cmd_info)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except ProjectLoadError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
