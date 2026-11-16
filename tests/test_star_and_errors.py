"""Star expansion, ambiguity and unresolved-item reporting (requirement #4)."""

from __future__ import annotations

from sql_lineage.models import UnresolvedKind

from .conftest import analyze_sql, find_output, has_base


def test_bare_star_expands_from_schema(analyzer):
    sql = "SELECT * FROM users u"
    _, blocks = analyze_sql(analyzer, sql)
    block = blocks[0]
    # users has 6 columns in the example schema.
    assert len(block.output_columns) == 6
    assert all(o.is_expanded_from_star for o in block.output_columns)
    names = {o.name for o in block.output_columns}
    assert names == {"id", "name", "email", "city", "status", "created_at"}
    _, first = find_output(blocks, "id")
    assert has_base(first.lineage, "users", "id")


def test_star_over_join_expands_every_relation(analyzer):
    sql = """
        SELECT *
        FROM users u
        JOIN orders o ON o.user_id = u.id
    """
    _, blocks = analyze_sql(analyzer, sql)
    block = blocks[0]
    assert len(block.output_columns) == 12  # 6 + 6


def test_qualified_star_over_subquery(analyzer):
    sql = """
        SELECT recent.*
        FROM (
            SELECT user_id, max(ordered_at) AS last_order_at
            FROM orders GROUP BY user_id
        ) AS recent
    """
    _, blocks = analyze_sql(analyzer, sql)
    block = blocks[0]
    assert [o.name for o in block.output_columns] == ["user_id", "last_order_at"]
    assert all(o.is_expanded_from_star for o in block.output_columns)
    _, last = find_output(blocks, "last_order_at")
    assert has_base(last.lineage, "orders", "ordered_at")


def test_ambiguous_unqualified_column_is_reported(analyzer):
    sql = """
        SELECT id, status
        FROM users
        JOIN orders ON orders.user_id = users.id
    """
    result, blocks = analyze_sql(analyzer, sql)
    kinds = [u.kind for u in blocks[0].unresolved]
    # `id` and `status` both exist on users and orders.
    assert kinds.count(UnresolvedKind.AMBIGUOUS_COLUMN) == 2
    # The unresolved leaf stays in the lineage tree rather than being dropped.
    ambiguous = [
        o for o in blocks[0].output_columns if o.name in ("id", "status")
    ]
    for output in ambiguous:
        assert any(
            n.unresolved is not None
            for n in _flatten(output.lineage)
        )
    # Location points into the source text.
    item = blocks[0].unresolved[0]
    assert item.location is not None
    assert item.location.line >= 1
    assert item.location.snippet


def test_unknown_table_and_column(analyzer):
    result, blocks = analyze_sql(
        analyzer, "SELECT id, legacy_flag FROM archived_users"
    )
    kinds = {u.kind for u in blocks[0].unresolved}
    assert UnresolvedKind.UNKNOWN_TABLE in kinds
    assert UnresolvedKind.UNKNOWN_COLUMN in kinds

    result2, blocks2 = analyze_sql(
        analyzer, "SELECT users.nonexistent_column FROM users"
    )
    assert any(
        u.kind is UnresolvedKind.UNKNOWN_COLUMN for u in blocks2[0].unresolved
    )


def test_unknown_alias_qualifier(analyzer):
    result, blocks = analyze_sql(
        analyzer, "SELECT phantom.name FROM users"
    )
    assert blocks[0].unresolved[0].kind is UnresolvedKind.UNKNOWN_TABLE


def test_star_unknown_qualifier(analyzer):
    result, blocks = analyze_sql(
        analyzer, "SELECT phantom.* FROM users"
    )
    assert blocks[0].unresolved[0].kind is UnresolvedKind.STAR_EXPANSION
    # No guessed outputs.
    assert blocks[0].output_columns == []


def test_parse_failure_is_captured_not_raised(analyzer):
    result = analyzer.analyze_statement(
        "SELECT FROM WHERE", "broken.sql", "SELECT FROM WHERE"
    )
    assert result.parse_failed is True
    assert result.unresolved[0].kind is UnresolvedKind.STATEMENT_FAILURE
    assert result.unresolved[0].location is not None


def test_recursive_cte_is_refused_without_looping(analyzer):
    sql = """
        WITH RECURSIVE counter(n) AS (
            SELECT 1
            UNION ALL
            SELECT n + 1 FROM counter WHERE n < 10
        )
        SELECT n FROM counter
    """
    result, blocks = analyze_sql(analyzer, sql)
    all_kinds = [u.kind for b in blocks for u in b.unresolved]
    assert UnresolvedKind.RECURSIVE_CTE in all_kinds
    assert any(b.unsupported for b in blocks)


def _flatten(nodes):
    for node in nodes:
        yield node
        yield from _flatten(node.children)
