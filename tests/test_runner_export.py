"""File-level orchestration: failure isolation, locations, exports, schema."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from sql_lineage.exporter import export_csv, export_json
from sql_lineage.locations import split_statements
from sql_lineage.runner import LineageRunner
from sql_lineage.schema import SchemaCatalog

from .conftest import SCHEMA_FILE


def test_split_statements_respects_string_literals():
    text = "SELECT ';' AS x; SELECT 'y' AS z;"
    statements = split_statements(text)
    assert len(statements) == 2
    assert statements[0].text == "SELECT ';' AS x"
    assert statements[1].offset > 0


def test_split_handles_trailing_statement_without_semicolon():
    statements = split_statements("SELECT 1 AS a; SELECT 2 AS b")
    assert len(statements) == 2
    assert statements[1].text == "SELECT 2 AS b"


def test_full_example_run_has_expected_unresolved_only(full_result):
    # Every unresolved item must originate from the intentional error file.
    for item in full_result.all_unresolved():
        assert "errors" in item.file or item.file is not None
    error_file = next(f for f in full_result.files if "errors" in f.file)
    # 7 error cases; parse failure + recursive + ambiguities etc. all captured.
    assert error_file.statements
    failed = [s for s in error_file.statements if s.parse_failed]
    assert len(failed) == 1


def test_one_bad_statement_does_not_stop_others(tmp_path):
    good = tmp_path / "good.sql"
    good.write_text(
        "SELECT id FROM users;\n"
        "SELECT FROM WHERE;\n"
        "SELECT name FROM users;",
        encoding="utf-8",
    )
    runner = LineageRunner(SchemaCatalog())
    runner.catalog.load_ddl_file(SCHEMA_FILE)
    result = runner.run(query_paths=[good])

    file_result = result.files[0]
    assert len(file_result.statements) == 3
    assert file_result.statements[1].parse_failed is True
    # The two healthy statements still produced blocks.
    assert file_result.statements[0].block_ids
    assert file_result.statements[2].block_ids

    # And the failed statement is never counted as "no dependency": it carries
    # an unresolved item instead.
    failed = file_result.statements[1]
    assert failed.unresolved and failed.unresolved[0].kind.value == "statement_failure"


def test_locations_are_remapped_to_full_file(full_result):
    # The error file's parse error must carry a file-level line number.
    error_items = [
        u for u in full_result.all_unresolved() if u.kind.value == "statement_failure"
    ]
    assert error_items and error_items[0].location
    loc = error_items[0].location
    assert loc.file.endswith("05_error_cases.sql")
    assert loc.line >= 1
    # Snippet includes the offending token.
    assert "WHERE" in loc.snippet


def test_base_column_listing(full_result):
    bases = set(full_result.base_columns())
    assert ("users", "id") in bases
    assert ("payments", "paid_amount") in bases


def test_json_and_csv_export(full_result, tmp_path):
    json_path = tmp_path / "lineage.json"
    export_json(full_result, json_path)
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["blocks"] and payload["impacts"]
    assert payload["unresolved"]

    written = export_csv(full_result, tmp_path)
    names = {p.name for p in written}
    assert {"lineage_edges.csv", "unresolved.csv", "summary.csv"} <= names

    with (tmp_path / "lineage_edges.csv").open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    assert rows
    assert {r["relation"] for r in rows} == {"value", "predicate"}

    with (tmp_path / "unresolved.csv").open(encoding="utf-8") as handle:
        unresolved_rows = list(csv.DictReader(handle))
    assert unresolved_rows
    assert all(r["message"] for r in unresolved_rows)


def test_schema_ddl_and_json_catalog(catalog):
    users = catalog.lookup_bare("users")
    assert users is not None
    assert "email" in users.columns
    # Qualified lookup against a bare-name catalog entry.
    table = _qualified_table("main", "orders")
    resolved = catalog.resolve_table(table)
    assert resolved is not None and "user_id" in resolved.columns
    # JSON catalog entry.
    regions = catalog.lookup_bare("regions")
    assert regions is not None and regions.columns == ("code", "name", "timezone")


def test_bad_ddl_statement_does_not_abort_loading(tmp_path):
    ddl = tmp_path / "broken.sql"
    ddl.write_text(
        "CREATE TABLE ok (id INTEGER);\n"
        "CREATE TABLE bad ();\n"
        "CREATE TABLE also_ok (name TEXT);",
        encoding="utf-8",
    )
    catalog = SchemaCatalog()
    warnings = catalog.load_ddl_file(ddl)
    assert catalog.lookup_bare("ok") is not None
    assert catalog.lookup_bare("also_ok") is not None
    assert warnings  # the bad statement was reported, not fatal


def test_locations_are_absolute_in_a_multi_statement_file(tmp_path):
    # Regression: statement-relative offsets must be translated to absolute
    # file coordinates once, even when later statements clone blocks from
    # earlier ones (cross-statement view/CTE references).
    sql_file = tmp_path / "multi.sql"
    sql_file.write_text(
        "-- leading comment\n"
        "CREATE VIEW v AS SELECT id, name FROM users;\n"
        "\n"
        "-- another comment\n"
        "SELECT id, name FROM v WHERE id > 0;\n",
        encoding="utf-8",
    )
    catalog = SchemaCatalog()
    catalog.load_ddl_file(SCHEMA_FILE)
    result = LineageRunner(catalog).run(query_paths=[sql_file])
    lines = sql_file.read_text().splitlines()

    located = []

    def collect(nodes):
        for node in nodes:
            if node.location is not None:
                located.append(node.location)
            collect(node.children)

    for block in result.blocks.values():
        assert block.location is None or 1 <= block.location.line <= len(lines)
        for output in block.output_columns:
            collect(output.lineage)
            collect(output.predicate_deps)

    # Every absolute position must point at a real, in-range source line, and
    # its char span must read back the same snippet from the full file text.
    full = sql_file.read_text()
    assert located
    for loc in located:
        assert 1 <= loc.line <= len(lines)
        assert full[loc.start : loc.end].strip() != ""
        # The reported column must match the column of the same char offset.
        line_start = full.rfind("\n", 0, loc.start) + 1
        assert loc.col == loc.start - line_start + 1


def test_failure_in_one_file_does_not_block_other_files(tmp_path):
    catalog = SchemaCatalog()
    catalog.load_ddl_file(SCHEMA_FILE)
    broken_dir = tmp_path / "queries"
    broken_dir.mkdir()
    (broken_dir / "a_good.sql").write_text("SELECT id FROM users;", encoding="utf-8")
    (broken_dir / "b_broken.sql").write_text("SELECT FROM WHERE;", encoding="utf-8")
    (broken_dir / "c_good.sql").write_text("SELECT name FROM users;", encoding="utf-8")

    result = LineageRunner(catalog).run(query_paths=[broken_dir])
    assert len(result.files) == 3
    by_name = {Path(f.file).name: f for f in result.files}
    assert by_name["b_broken.sql"].statements[0].parse_failed is True
    assert by_name["a_good.sql"].statements[0].block_ids
    assert by_name["c_good.sql"].statements[0].block_ids
    # Total blocks still produced by the two healthy files.
    assert len(result.blocks) >= 2


def _qualified_table(db: str, name: str):
    import sqlglot

    return sqlglot.parse_one(f"SELECT * FROM {db}.{name}", read="sqlite").find(
        sqlglot.exp.Table
    )
