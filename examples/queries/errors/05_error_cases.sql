-- 05_error_cases.sql
-- Intentionally problematic statements. Each failure must be reported with its
-- file position and SQL snippet as an *unresolved item*, must not produce
-- guessed lineage, and must not stop analysis of the other statements.

-- 1) Ambiguous unqualified column: `status` exists on both joined tables.
SELECT id, status
FROM users
JOIN orders ON orders.user_id = users.id;

-- 2) Unknown table (not present in the schema input).
SELECT id, legacy_flag
FROM archived_users;

-- 3) Unknown column on a known table.
SELECT users.nonexistent_column
FROM users;

-- 4) Unknown alias used as a column qualifier.
SELECT phantom.name
FROM users;

-- 5) Unparseable syntax (sqlglot raises a parse error with a position).
SELECT FROM WHERE;

-- 6) Recursive CTE: explicitly unsupported, must be flagged, never looped on.
WITH RECURSIVE counter(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM counter WHERE n < 10
)
SELECT n FROM counter;

-- 7) Qualified star over an alias that does not exist in the scope.
SELECT phantom.*
FROM users;
