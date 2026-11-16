"""Command line entry point.

Examples
--------

Analyze every ``.sql`` file under ``queries/`` against a sqlite DDL schema and
serve the web viewer::

    python -m sql_lineage.cli analyze \\
        --schema examples/schema/schema.sql \\
        --queries examples/queries \\
        --out build/lineage --serve --port 8000

Just produce exports::

    python -m sql_lineage.cli analyze --schema schema.sql --queries q1.sql q2.sql \\
        --json-catalog catalog.json --out build/lineage
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .exporter import export_csv, export_json
from .runner import LineageRunner
from .schema import SchemaCatalog


def _collect_query_paths(paths: list[str]) -> list[Path]:
    collected: list[Path] = []
    for raw in paths:
        path = Path(raw)
        if path.is_dir():
            collected.extend(sorted(path.rglob("*.sql")))
        else:
            collected.append(path)
    # Stable de-duplication.
    seen: set[str] = set()
    unique: list[Path] = []
    for path in collected:
        key = str(path.resolve())
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sql_lineage",
        description="Offline sqlite SQL field-lineage analyzer",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    analyze = sub.add_parser("analyze", help="analyze SQL files and export results")
    analyze.add_argument(
        "--queries",
        nargs="+",
        required=True,
        help="SQL files or directories containing query files",
    )
    analyze.add_argument(
        "--schema",
        nargs="*",
        default=[],
        help="sqlite DDL files with CREATE TABLE statements",
    )
    analyze.add_argument(
        "--json-catalog",
        nargs="*",
        default=[],
        help="JSON files describing table structures",
    )
    analyze.add_argument(
        "--out",
        required=True,
        help="output directory for JSON/CSV exports",
    )
    analyze.add_argument(
        "--serve",
        action="store_true",
        help="start the local web viewer after analysis",
    )
    analyze.add_argument("--host", default="127.0.0.1")
    analyze.add_argument("--port", type=int, default=8000)
    return parser


def run_analyze(args: argparse.Namespace) -> int:
    catalog = SchemaCatalog()
    runner = LineageRunner(catalog)
    query_paths = _collect_query_paths(args.queries)
    if not query_paths:
        print("no .sql query files found", file=sys.stderr)
        return 2

    result = runner.run(
        query_paths=query_paths,
        schema_paths=args.schema,
        json_catalog_paths=args.json_catalog,
    )

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "lineage.json"
    export_json(result, json_path)
    csv_paths = export_csv(result, out_dir)

    unresolved = result.all_unresolved()
    print(f"analyzed {len(query_paths)} query file(s)")
    print(f"  query blocks: {len(result.blocks)}")
    print(f"  unresolved items: {len(unresolved)}")
    for warning in result.schema_warnings:
        print(f"  schema warning: {warning}")
    print(f"  wrote {json_path}")
    for path in csv_paths:
        print(f"  wrote {path}")

    if args.serve:
        from .web.server import serve

        print(f"\nweb viewer: http://{args.host}:{args.port}/")
        serve(json_path, host=args.host, port=args.port)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "analyze":
        return run_analyze(args)
    parser.error(f"unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
