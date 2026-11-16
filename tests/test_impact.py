"""Reverse impact analysis and cross-query view references."""

from __future__ import annotations

from sql_lineage.impact import ImpactAnalyzer

from .conftest import analyze_sql, find_output, has_base


def test_reverse_impact_splits_value_and_predicate(analyzer):
    sql = """
        SELECT u.id AS user_id,
               sum(o.amount) AS total,
               count(o.id) AS order_count
        FROM users u
        JOIN orders o ON o.user_id = u.id
        WHERE u.status = 'active'
        GROUP BY u.id
    """
    _, blocks = analyze_sql(analyzer, sql)
    impacts = ImpactAnalyzer(analyzer.blocks)

    status = impacts.impact_of("users", "status")
    # status only filters rows: predicate impacts, no value impacts.
    assert status.value_impacts == []
    assert {p.output_column for p in status.predicate_impacts} == {
        "user_id",
        "total",
        "order_count",
    }

    amount = impacts.impact_of("orders", "amount")
    assert {p.output_column for p in amount.value_impacts} == {"total"}

    user_id_join = impacts.impact_of("orders", "user_id")
    # JOIN column is predicate-only for every output.
    assert user_id_join.value_impacts == []
    assert len(user_id_join.predicate_impacts) == 3


def test_impact_path_keeps_intermediate_hops(analyzer):
    sql = """
        WITH per_user AS (
            SELECT user_id, sum(amount) AS total
            FROM orders GROUP BY user_id
        )
        SELECT user_id, total AS grand FROM per_user
    """
    _, blocks = analyze_sql(analyzer, sql)
    impacts = ImpactAnalyzer(analyzer.blocks)
    amount = impacts.impact_of("orders", "amount")
    assert len(amount.value_impacts) == 2  # CTE output + final output

    final = next(p for p in amount.value_impacts if p.output_column == "grand")
    labels = [h.column for h in final.hops]
    # Base column -> SUM wrapper -> CTE output -> final output.
    assert labels[0] == "amount"
    assert "total" in labels
    assert labels[-1] == "grand"
    assert all(h.location is not None for h in final.hops if h.column != "grand" or True)


def test_case_condition_flows_to_predicate_impacts(analyzer):
    sql = """
        WITH s AS (
            SELECT user_id, count(id) AS order_count FROM orders GROUP BY user_id
        )
        SELECT user_id,
               CASE WHEN order_count >= 5 THEN 1 ELSE 0 END AS is_vip
        FROM s
    """
    _, blocks = analyze_sql(analyzer, sql)
    impacts = ImpactAnalyzer(analyzer.blocks)
    order_id = impacts.impact_of("orders", "id")
    vip_predicate = [p for p in order_id.predicate_impacts if p.output_column == "is_vip"]
    assert len(vip_predicate) == 1
    chain = [(h.kind.value, h.column) for h in vip_predicate[0].hops]
    assert chain[0] == ("predicate", "id")
    assert chain[-1] == ("predicate", "is_vip")
    assert any(col == "order_count" for _, col in chain)


def test_cross_statement_view_chain(analyzer):
    ddl1 = """
        CREATE TEMP VIEW summary AS
        SELECT u.id AS user_id, u.name AS user_name, count(o.id) AS order_count
        FROM users u LEFT JOIN orders o ON o.user_id = u.id
        GROUP BY u.id, u.name
    """
    ddl2 = """
        SELECT user_id, user_name, order_count AS cnt FROM summary
    """
    r1 = analyzer.analyze_statement(ddl1, "views.sql", ddl1)
    assert r1.registered_name == "summary"
    r2 = analyzer.analyze_statement(ddl2, "views.sql", ddl2)

    final_block = analyzer.blocks[r2.block_ids[0]]
    _, cnt = find_output([final_block], "cnt")
    assert has_base(cnt.lineage, "orders", "id")
    _, user_name = find_output([final_block], "user_name")
    assert has_base(user_name.lineage, "users", "name")


def test_explicit_view_column_list_renames_outputs(analyzer):
    sql = """
        CREATE VIEW v(pk, label) AS
        SELECT id, name FROM users
    """
    result = analyzer.analyze_statement(sql, "v.sql", sql)
    block = analyzer.blocks[result.registered_block_id]
    assert [o.name for o in block.output_columns] == ["pk", "label"]
    _, pk = find_output([block], "pk")
    assert has_base(pk.lineage, "users", "id")


def test_all_impacts_covers_value_and_predicate_bases(analyzer):
    sql = """
        SELECT id AS x, name AS y FROM users WHERE city = 'X'
    """
    analyze_sql(analyzer, sql)
    all_impacts = ImpactAnalyzer(analyzer.blocks).all_impacts()
    assert "users.id" in all_impacts
    assert "users.city" in all_impacts
    assert all_impacts["users.city"].value_impacts == []
    assert len(all_impacts["users.city"].predicate_impacts) == 2
