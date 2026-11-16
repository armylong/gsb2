"""Export lineage relationships and unresolved items.

Three machine-readable outputs are produced together so downstream consumers
never mistake an analysis gap for an empty dependency set:

* ``lineage.json``  — full structured result (blocks, paths, predicates,
  unresolved items, schema);
* ``lineage_edges.csv`` — flattened value/predicate edges with every
  intermediate hop expanded;
* ``unresolved.csv`` — every unresolved item with its file and SQL snippet.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from .impact import ImpactAnalyzer
from .models import LineageNode, QueryBlock
from .runner import AnalysisResult


def export_json(result: AnalysisResult, path: str | Path) -> None:
    payload = result.to_dict()
    payload["impacts"] = {
        key: impact.to_dict()
        for key, impact in ImpactAnalyzer(result.blocks).all_impacts().items()
    }
    Path(path).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def export_csv(result: AnalysisResult, directory: str | Path) -> list[Path]:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    edges_path = directory / "lineage_edges.csv"
    unresolved_path = directory / "unresolved.csv"
    summary_path = directory / "summary.csv"

    with edges_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "file",
                "block_id",
                "block_kind",
                "output_ordinal",
                "output_column",
                "relation",
                "depth",
                "hop_table",
                "hop_block",
                "hop_column",
                "transform",
                "hop_sql",
                "location",
            ]
        )
        for block in _sorted_blocks(result):
            for output in block.output_columns:
                for role_name, nodes in (
                    ("value", output.lineage),
                    ("predicate", output.predicate_deps),
                ):
                    _write_tree_rows(writer, block, output, role_name, nodes)

    with unresolved_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["file", "block_id", "kind", "message", "line", "col", "snippet"]
        )
        for item in result.all_unresolved():
            location = item.location
            writer.writerow(
                [
                    item.file or (location.file if location else ""),
                    item.block_id or "",
                    item.kind.value,
                    item.message,
                    location.line if location else "",
                    location.col if location else "",
                    location.snippet if location else "",
                ]
            )

    with summary_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "file",
                "block_id",
                "block_kind",
                "outputs",
                "value_base_columns",
                "predicate_base_columns",
                "unresolved_count",
                "unsupported",
            ]
        )
        for block in _sorted_blocks(result):
            value_bases: set[tuple[str, str]] = set()
            predicate_bases: set[tuple[str, str]] = set()
            for output in block.output_columns:
                _scan(output.lineage, value_bases)
                _scan(output.predicate_deps, predicate_bases)
            _scan(block.block_predicate_deps, predicate_bases)
            writer.writerow(
                [
                    block.file,
                    block.block_id,
                    block.kind.value,
                    len(block.output_columns),
                    ";".join(f"{t}.{c}" for t, c in sorted(value_bases)),
                    ";".join(f"{t}.{c}" for t, c in sorted(predicate_bases)),
                    len(block.unresolved),
                    block.unsupported,
                ]
            )

    return [edges_path, unresolved_path, summary_path]


def _sorted_blocks(result: AnalysisResult) -> list[QueryBlock]:
    return [
        result.blocks[key]
        for key in sorted(result.blocks, key=lambda k: (result.blocks[k].file, k))
    ]


def _write_tree_rows(
    writer: csv.writer,
    block: QueryBlock,
    output,
    relation: str,
    nodes: list[LineageNode],
    depth: int = 0,
) -> None:
    for node in nodes:
        location = node.location
        writer.writerow(
            [
                block.file,
                block.block_id,
                block.kind.value,
                output.ordinal,
                output.name,
                relation,
                depth,
                node.table or "",
                node.block or "",
                node.column,
                node.transform or "",
                node.expression,
                (
                    f"{location.file}:{location.line}:{location.col}"
                    if location
                    else ""
                ),
            ]
        )
        _write_tree_rows(
            writer, block, output, relation, node.children, depth + 1
        )


def _scan(nodes: list[LineageNode], sink: set[tuple[str, str]]) -> None:
    for node in nodes:
        if node.is_base():
            sink.add((node.table or "", node.column))
        _scan(node.children, sink)
