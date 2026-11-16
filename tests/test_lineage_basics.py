"""Core lineage behavior: aliases, joins, multi-source expressions, aggregates."""

from __future__ import annotations

from sql_lineage.schema import normalize_name

from .conftest import analyze_sql, base_columns, find_output, has_base


def test_table_alias_and_renamed_projection(analyzer):
    sql = """
        SELECT u.id AS user_id, upper(u.name) AS user_name
        FROM users AS u
        WHERE u.status = 'active'
    """
    _, blocks = analyze_sql(analyzer, sql)
    block, user_id = find_output(blocks, "user_id")
    assert base_columns(user_id.lineage) == [("value", "users", "id")]

    _, user_name = find_output(blocks, "user_name")
    assert has_base(user_name.lineage, "users", "name")


def test_multi_source_expression_keeps_every_source(analyzer):
    # Requirement #2: a || b must keep BOTH sources, not just one.
    sql = """
        SELECT u.email || ' <' || u.city AS contact,
               o.amount * oi.quantity AS gross
        FROM users u
        JOIN orders o ON o.user_id = u.id
        JOIN order_items oi ON oi.order_id = o.id
    """
    _, blocks = analyze_sql(analyzer, sql)
    _, contact = find_output(blocks, "contact")
    value_bases = {(t, c) for r, t, c in base_columns(contact.lineage)}
    assert ("users", "email") in value_bases
    assert ("users", "city") in value_bases

    _, gross = find_output(blocks, "gross")
    gross_bases = {(t, c) for r, t, c in base_columns(gross.lineage)}
    assert gross_bases == {("orders", "amount"), ("order_items", "quantity")}


def test_aggregate_preserves_underlying_sources(analyzer):
    sql = """
        SELECT count(o.id) AS order_count,
               sum(o.amount * oi.quantity) AS gmv,
               count(*) AS rows_count
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        GROUP BY o.id
    """
    _, blocks = analyze_sql(analyzer, sql)
    _, order_count = find_output(blocks, "order_count")
    assert order_count.is_aggregate
    assert has_base(order_count.lineage, "orders", "id")

    _, gmv = find_output(blocks, "gmv")
    assert gmv.is_aggregate
    assert has_base(gmv.lineage, "orders", "amount")
    assert has_base(gmv.lineage, "order_items", "quantity")

    # count(*) references no concrete field and is not flagged unresolved.
    _, rows_count = find_output(blocks, "rows_count")
    assert base_columns(rows_count.lineage) == []
    assert blocks[0].unresolved == []


def test_case_expression_separates_value_and_condition(analyzer):
    sql = """
        SELECT CASE WHEN u.city = 'Beijing' THEN u.name ELSE u.email END AS label
        FROM users u
    """
    _, blocks = analyze_sql(analyzer, sql)
    _, label = find_output(blocks, "label")

    value_bases = {
        (t, c) for r, t, c in base_columns(label.lineage) if r == "value"
    }
    predicate_bases = {
        (t, c) for r, t, c in base_columns(label.lineage) if r == "predicate"
    }
    assert value_bases == {("users", "name"), ("users", "email")}
    assert predicate_bases == {("users", "city")}


def test_where_join_groupby_are_predicate_only(analyzer):
    # Requirement #3: filters never become value sources.
    sql = """
        SELECT u.id AS user_id, sum(o.amount) AS total
        FROM users u
        JOIN orders o ON o.user_id = u.id
        WHERE u.status = 'active' AND o.status = 'paid'
        GROUP BY u.id
        HAVING sum(o.amount) > 10
    """
    _, blocks = analyze_sql(analyzer, sql)
    block, user_id = find_output(blocks, "user_id")

    value_bases = {(t, c) for r, t, c in base_columns(user_id.lineage)}
    assert value_bases == {("users", "id")}

    pred_bases = {
        (t, c) for r, t, c in base_columns(user_id.predicate_deps)
    }
    assert ("users", "status") in pred_bases
    assert ("orders", "status") in pred_bases
    assert ("orders", "user_id") in pred_bases  # JOIN ON


def test_window_function_partition_is_predicate(analyzer):
    sql = """
        SELECT row_number() OVER (PARTITION BY user_id ORDER BY ordered_at) AS rn,
               amount AS amt
        FROM orders
    """
    _, blocks = analyze_sql(analyzer, sql)
    _, rn = find_output(blocks, "rn")
    pred = {
        (t, c) for r, t, c in base_columns(rn.lineage) if r == "predicate"
    }
    value = {
        (t, c) for r, t, c in base_columns(rn.lineage) if r == "value"
    }
    assert ("orders", "user_id") in pred
    assert ("orders", "ordered_at") in pred
    # row_number has no value column itself; amount column is untouched here.
    assert all(t != "orders" or c != "amount" for t, c in value)


def test_normalize_name_is_case_insensitive():
    assert normalize_name("Users") == normalize_name("users")
    assert normalize_name('"ID"') == "id"
