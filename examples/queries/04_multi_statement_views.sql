-- 04_multi_statement_views.sql
-- Multiple statements in one file with cross-query references through a
-- temporary view. Statements are analyzed independently, and later statements
-- resolve their sources through names registered by earlier ones.

CREATE TEMP VIEW user_order_summary AS
SELECT
    u.id AS user_id,
    u.name AS user_name,
    count(o.id) AS order_count,
    sum(o.amount) AS total_amount
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.name;

-- Re-references the view registered above; the lineage continues through it.
CREATE TEMP VIEW vip_users AS
SELECT
    s.user_id,
    s.user_name,
    s.total_amount,
    CASE WHEN s.order_count >= 5 THEN 1 ELSE 0 END AS is_vip
FROM user_order_summary s
WHERE s.total_amount > 1000;

-- Final ad-hoc query on top of both views.
SELECT
    v.user_id,
    v.user_name,
    v.is_vip,
    s.order_count
FROM vip_users v
JOIN user_order_summary s ON s.user_id = v.user_id;
