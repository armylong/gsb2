"""Execute the example queries against an in-memory sqlite database.

This proves every *supported* example query is valid sqlite SQL. The error-case
file under queries/errors/ is intentionally excluded — those statements are
there to exercise unresolved-item reporting, not execution.

Run:  .venv/bin/python examples/run_queries_in_sqlite.py
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "examples" / "schema" / "schema.sql"
QUERY_DIR = ROOT / "examples" / "queries"

SEED = """
INSERT INTO users (id, name, email, city, status, created_at) VALUES
  (1, 'Alice', 'alice@example.com', 'Beijing', 'active', '2026-02-01'),
  (2, 'Bob',   'bob@example.com',   'Shanghai', 'active', '2025-12-01'),
  (3, 'Carol', 'carol@example.com', 'Shenzhen', 'inactive', '2026-03-01');

INSERT INTO orders (id, user_id, amount, currency, status, ordered_at) VALUES
  (10, 1, 100.0, 'CNY', 'paid', '2026-02-02'),
  (11, 1, 50.0,  'CNY', 'paid', '2026-02-05'),
  (12, 2, 200.0, 'USD', 'paid', '2026-01-10');

INSERT INTO order_items (id, order_id, product, quantity, unit_price) VALUES
  (100, 10, 'book',  2, 40.0),
  (101, 10, 'pen',   4, 5.0),
  (102, 11, 'desk',  1, 50.0),
  (103, 12, 'lamp',  2, 100.0);

INSERT INTO payments (id, order_id, paid_amount, method, paid_at) VALUES
  (1000, 10, 100.0, 'card',  '2026-02-03'),
  (1001, 11, 50.0,  'cash',  '2026-02-06'),
  (1002, 12, 200.0, 'card',  '2026-01-11');
"""


def main() -> int:
    connection = sqlite3.connect(":memory:")
    connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    connection.executescript(SEED)

    query_files = sorted(p for p in QUERY_DIR.rglob("*.sql") if "errors" not in p.parts)
    failures = 0
    for path in query_files:
        script = path.read_text(encoding="utf-8")
        try:
            # executescript tolerates multi-statement / CREATE TEMP VIEW files.
            cursor = connection.executescript(script)
            rows = cursor.fetchall() if cursor.description else []
            print(f"OK   {path.relative_to(ROOT)} ({len(rows)} rows from final cursor)")
        except sqlite3.Error as exc:
            failures += 1
            print(f"FAIL {path.relative_to(ROOT)}: {exc}", file=sys.stderr)

    if failures:
        print(f"\n{failures} query file(s) failed", file=sys.stderr)
        return 1
    print(f"\nall {len(query_files)} supported example files executed successfully")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
