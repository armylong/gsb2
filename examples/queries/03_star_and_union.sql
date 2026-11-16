-- 03_star_and_union.sql
-- Star expansion against schema and against subquery outputs, plus a UNION ALL
-- whose branches are aligned by output position (requirement #5).

-- Bare star over a join: expands to every column of both relations.
SELECT *
FROM users AS u
JOIN orders AS o
    ON o.user_id = u.id
WHERE o.currency = 'CNY';

-- Qualified star over a derived table; the derived columns come from below.
SELECT recent.*
FROM (
    SELECT
        user_id,
        max(ordered_at) AS last_order_at,
        count(*)        AS order_count
    FROM orders
    GROUP BY user_id
) AS recent;

-- Merge query: branch columns differ in name but correspond by position.
SELECT id, user_id AS party_id, amount, 'order' AS source_type
FROM orders
UNION ALL
SELECT id, order_id AS party_id, paid_amount, 'payment' AS source_type
FROM payments;
