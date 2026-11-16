"""Subqueries, CTE scoping/shadowing and set-operation alignment."""

from __future__ import annotations

from sql_lineage.models import BlockKind

from .conftest import analyze_sql, base_columns, find_output, has_base


def test_from_subquery_chains_through(analyzer):
    sql = """
        SELECT recent.user_id, recent.last_order_at
        FROM (
            SELECT user_id, max(ordered_at) AS last_order_at
            FROM orders
            GROUP BY user_id
        ) AS recent
    """
    _, blocks = analyze_sql(analyzer, sql)
    top = [b for b in blocks if b.kind == BlockKind.SELECT][0]
    _, last = find_output([top], "last_order_at")
    assert has_base(last.lineage, "orders", "ordered_at")
    assert top.referenced_blocks


def test_scalar_subquery_value_lineage(analyzer):
    sql = """
        SELECT u.id AS user_id,
               (SELECT max(p.paid_amount) FROM payments p
                JOIN orders o2 ON o2.id = p.order_id
                WHERE o2.user_id = u.id) AS biggest
        FROM users u
    """
    _, blocks = analyze_sql(analyzer, sql)
    _, biggest = find_output(blocks, "biggest")
    assert has_base(biggest.lineage, "payments", "paid_amount")
    # Correlated filter inside the scalar subquery stays predicate-only.
    pred = {(t, c) for r, t, c in base_columns(biggest.lineage) if r == "predicate"}
    assert ("orders", "user_id") in pred
    # The correlated outer column appears as a value input too (it is read).
    assert has_base(biggest.lineage, "users", "id")


def test_cte_scope_shadowing_does_not_cross_link(analyzer):
    # Requirement #5: same CTE name in two scopes must stay independent.
    sql = """
        WITH active_users AS (
            SELECT id, name, city FROM users WHERE status = 'active'
        )
        SELECT au.id, recent.last_order_at
        FROM active_users AS au
        JOIN (
            WITH active_users AS (
                SELECT id FROM users WHERE created_at >= '2026-01-01'
            )
            SELECT o.user_id AS uid, max(o.ordered_at) AS last_order_at
            FROM orders o
            JOIN active_users iu ON iu.id = o.user_id
            GROUP BY o.user_id
        ) AS recent ON recent.uid = au.id
    """
    _, blocks = analyze_sql(analyzer, sql)
    cte_blocks = [b for b in blocks if b.kind == BlockKind.CTE]
    names = [b.name for b in cte_blocks]
    assert names.count("active_users") == 2
    assert cte_blocks[0].block_id != cte_blocks[1].block_id

    # Inner CTE only exposes `id`; it must resolve independently of the outer
    # CTE which exposes id/name/city.
    inner = cte_blocks[1]
    assert [o.name for o in inner.output_columns] == ["id"]
    for block in blocks:
        assert block.unresolved == []


def test_union_aligns_branches_by_position(analyzer):
    sql = """
        SELECT id, user_id AS party_id, amount, 'order' AS source_type
        FROM orders
        UNION ALL
        SELECT id, order_id AS party_id, paid_amount, 'payment'
        FROM payments
    """
    _, blocks = analyze_sql(analyzer, sql)
    setop = next(b for b in blocks if b.kind == BlockKind.SETOP)
    assert [o.name for o in setop.output_columns] == [
        "id",
        "party_id",
        "amount",
        "source_type",
    ]
    # Second output merges orders.user_id with payments.order_id.
    party = setop.output_columns[1]
    bases = {(t, c) for r, t, c in base_columns(party.lineage)}
    assert ("orders", "user_id") in bases
    assert ("payments", "order_id") in bases

    # Literal-only branch is recorded as a constant, not as "no dependency".
    source_type = setop.output_columns[3]
    transforms = []

    def collect(nodes):
        for n in nodes:
            transforms.append(n.transform)
            collect(n.children)

    collect(source_type.lineage)
    assert "constant" in transforms


def test_intersect_and_except_are_supported(analyzer):
    sql = """
        SELECT user_id FROM orders WHERE amount > 100
        INTERSECT
        SELECT user_id FROM orders WHERE status = 'paid'
    """
    result, blocks = analyze_sql(analyzer, sql)
    assert result.unresolved == []
    assert any(b.kind == BlockKind.SETOP for b in blocks)
