-- 02_subqueries_ctes.sql
-- CTEs, subqueries in FROM, scalar subqueries, CASE with predicate branches
-- and an inner CTE that shadows an outer CTE of the same name (requirement #5).

WITH active_users AS (
    SELECT id, name, city
    FROM users
    WHERE status = 'active'
)
SELECT
    au.id AS user_id,
    au.name AS user_name,
    CASE
        WHEN au.city = 'Beijing' THEN 'north'
        WHEN au.city = 'Shanghai' THEN 'east'
        ELSE 'other'
    END AS region,
    (
        SELECT max(p.paid_amount)
        FROM payments p
        JOIN orders o2 ON o2.id = p.order_id
        WHERE o2.user_id = au.id
    ) AS largest_payment,
    recent.last_order_at
FROM active_users AS au
JOIN (
    -- Same CTE name 'active_users' as the outer scope: this inner binding must
    -- not cross-link with the outer one.
    WITH active_users AS (
        SELECT id FROM users WHERE created_at >= '2026-01-01'
    )
    SELECT o.user_id AS uid, max(o.ordered_at) AS last_order_at
    FROM orders o
    JOIN active_users iu ON iu.id = o.user_id
    GROUP BY o.user_id
) AS recent
    ON recent.uid = au.id;
