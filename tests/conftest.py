"""Shared pytest fixtures and tree-inspection helpers."""

from __future__ import annotations

from pathlib import Path

import pytest

from sql_lineage.analyzer import Analyzer
from sql_lineage.models import LineageNode, RefKind
from sql_lineage.runner import LineageRunner
from sql_lineage.schema import SchemaCatalog

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_FILE = ROOT / "examples" / "schema" / "schema.sql"
CATALOG_JSON = ROOT / "examples" / "schema" / "extra_catalog.json"
QUERY_DIR = ROOT / "examples" / "queries"


@pytest.fixture()
def catalog() -> SchemaCatalog:
    schema = SchemaCatalog()
    schema.load_ddl_file(SCHEMA_FILE)
    schema.load_json_file(CATALOG_JSON)
    return schema


@pytest.fixture()
def analyzer(catalog: SchemaCatalog) -> Analyzer:
    return Analyzer(catalog)


@pytest.fixture()
def full_result(catalog: SchemaCatalog):
    runner = LineageRunner(catalog)
    return runner.run(query_paths=[QUERY_DIR])


def analyze_sql(analyzer: Analyzer, sql: str, file: str = "test.sql"):
    result = analyzer.analyze_statement(sql, file, sql)
    # Return every block created by the statement, including nested CTEs and
    # subqueries (creation order is preserved by dict ordering).
    created = set()
    blocks = []
    for bid in result.block_ids:
        _collect_block(analyzer, bid, created, blocks)
    return result, blocks


def _collect_block(analyzer, block_id, seen, out):
    if block_id in seen or block_id not in analyzer.blocks:
        return
    seen.add(block_id)
    block = analyzer.blocks[block_id]
    out.append(block)
    for ref in block.referenced_blocks:
        _collect_block(analyzer, ref, seen, out)


def base_columns(nodes: list[LineageNode], role: RefKind | None = None):
    """Flatten a lineage tree to (role, table, column) base-column triples."""

    found: list[tuple[str, str, str]] = []

    def walk(tree: list[LineageNode]) -> None:
        for node in tree:
            if node.is_base() and (role is None or node.kind is role):
                found.append((node.kind.value, node.table, node.column))
            walk(node.children)

    walk(nodes)
    return found


def has_base(
    nodes: list[LineageNode], table: str, column: str, role: RefKind | None = None
) -> bool:
    return any(
        t == table and c == column and (role is None or r == role.value)
        for r, t, c in base_columns(nodes)
    )


def find_output(blocks, name: str):
    for block in blocks:
        for output in block.output_columns:
            if output.name == name:
                return block, output
    raise AssertionError(f"output column {name!r} not found")


def unresolved_kinds(result_or_block) -> list[str]:
    return [item.kind.value for item in result_or_block.unresolved]
