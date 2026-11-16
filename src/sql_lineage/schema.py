"""Local table-structure input.

Two input formats are supported, neither of which requires a live database:

1. sqlite DDL scripts (``CREATE TABLE ...``) — parsed with sqlglot;
2. a JSON catalog of the form::

       {
         "tables": [
           {"name": "users", "columns": ["id", "name"]},
           {"name": "main.orders", "columns": ["id", "user_id", "total"]}
         ]
       }

Names are normalized case-insensitively (sqlite semantics) while the original
spelling is preserved for display. Both ``users`` and ``main.users`` can be
looked up, and a query that qualifies a table resolves against a catalog that
only stored the bare name.
"""

from __future__ import annotations

import json
from pathlib import Path

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from .models import TableSchema


def normalize_name(name: str) -> str:
    return name.strip().strip('"').strip("`").lower()


def table_key(catalog: str | None, name: str) -> str:
    parts = [p for p in (catalog, name) if p]
    return normalize_name(".".join(parts))


class SchemaCatalog:
    def __init__(self) -> None:
        # normalized name -> TableSchema (original spelling kept inside)
        self._tables: dict[str, TableSchema] = {}
        # bare normalized name -> normalized full name, for unqualified lookups
        self._bare_index: dict[str, str] = {}

    # -- loading ----------------------------------------------------------

    def add_table(self, name: str, columns: list[str]) -> None:
        schema = TableSchema(name=name, columns=tuple(columns))
        key = table_key(None, name)
        self._tables[key] = schema
        bare = normalize_name(name.split(".")[-1])
        self._bare_index.setdefault(bare, key)

    def load_ddl_text(self, text: str, source: str = "<schema>") -> list[str]:
        """Parse CREATE TABLE statements from DDL text.

        Returns human-readable warnings for statements that could not be read;
        a bad DDL statement never aborts loading the rest of the file.
        """

        warnings: list[str] = []
        try:
            statements = sqlglot.parse(text, read="sqlite")
        except ParseError as exc:
            warnings.append(f"{source}: cannot parse schema file: {exc}")
            return warnings

        for stmt in statements:
            if stmt is None:
                continue
            create = stmt if isinstance(stmt, exp.Create) else None
            if create is None or not isinstance(create.this, exp.Schema):
                warnings.append(
                    f"{source}: skipping non-CREATE-TABLE statement: {stmt.sql()[:80]}"
                )
                continue
            table = create.this.this
            columns = [
                coldef.name
                for coldef in create.this.expressions
                if isinstance(coldef, exp.ColumnDef)
            ]
            if not columns:
                warnings.append(f"{source}: table {table.sql()} has no columns")
                continue
            self.add_table(table.sql(dialect="sqlite"), columns)
        return warnings

    def load_ddl_file(self, path: str | Path) -> list[str]:
        text = Path(path).read_text(encoding="utf-8")
        return self.load_ddl_text(text, source=str(path))

    def load_json_file(self, path: str | Path) -> list[str]:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        warnings: list[str] = []
        tables = data.get("tables", []) if isinstance(data, dict) else data
        for entry in tables:
            name = entry.get("name")
            columns = entry.get("columns")
            if not name or not columns:
                warnings.append(f"{path}: invalid catalog entry: {entry!r}")
                continue
            self.add_table(name, list(columns))
        return warnings

    # -- lookup -----------------------------------------------------------

    def resolve_table(self, table: exp.Table) -> TableSchema | None:
        key = table_key(table.db or None, table.name)
        if key in self._tables:
            return self._tables[key]
        bare = normalize_name(table.name)
        fallback = self._bare_index.get(bare)
        return self._tables[fallback] if fallback else None

    def lookup_bare(self, bare_name: str) -> TableSchema | None:
        key = self._bare_index.get(normalize_name(bare_name))
        return self._tables[key] if key else None

    def resolve_table_by_binding(self, binding: object) -> TableSchema | None:
        """Resolve the schema for a Binding whose ``table_name`` is a key."""

        table_name = getattr(binding, "table_name", None)
        if table_name is None:
            return None
        schema = self._tables.get(normalize_name(table_name))
        if schema is not None:
            return schema
        bare = normalize_name(str(table_name).split(".")[-1])
        fallback = self._bare_index.get(bare)
        return self._tables[fallback] if fallback else None

    def has_table(self, name: str) -> bool:
        return table_key(None, name) in self._tables

    def all_tables(self) -> list[TableSchema]:
        return sorted(self._tables.values(), key=lambda t: t.name)

    def column_exists(self, table_name: str, column_name: str) -> bool:
        schema = self._tables.get(table_key(None, table_name))
        if schema is None:
            schema = self.lookup_bare(table_name)
        if schema is None:
            return False
        wanted = normalize_name(column_name)
        return any(normalize_name(c) == wanted for c in schema.columns)
