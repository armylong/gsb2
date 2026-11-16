-- 01_basic_joins.sql
-- Table aliases, multi-table joins, renamed columns, multi-source computed
-- expressions and predicate-only dependencies (WHERE / JOIN ON / GROUP BY).

SELECT
    u.id                                   AS user_id,
    upper(u.name)                          AS user_name,
    u.email || ' <' || u.city || '>'       AS contact,
    count(o.id)                            AS order_count,
    sum(o.amount * oi.quantity)            AS gmv,
    avg(oi.unit_price)                     AS avg_unit_price
FROM users AS u
JOIN orders AS o
    ON o.user_id = u.id
JOIN order_items AS oi
    ON oi.order_id = o.id
WHERE u.status = 'active'
  AND o.status = 'paid'
GROUP BY u.id, u.name, u.email, u.city
HAVING count(o.id) > 0
ORDER BY gmv DESC;
