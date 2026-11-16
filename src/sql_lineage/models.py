"""Core data structures for the SQL field lineage analyzer.

The analyzer never connects to a database. Everything is derived from:

* parsed SQL text (sqlglot AST, dialect fixed to sqlite),
* a local schema description (sqlite DDL files or JSON catalogs).

Lineage is represented as explicit path trees rather than flattened edges, so
that an output field with several source columns (e.g. ``a || b``) keeps every
source and so intermediate query blocks stay visible in the path.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Optional, Union


# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Location:
    """A source text position inside an analyzed file."""

    file: str
    line: int
    col: int
    start: int
    end: int
    snippet: str

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "col": self.col,
            "start": self.start,
            "end": self.end,
            "snippet": self.snippet,
        }


# ---------------------------------------------------------------------------
# Lineage paths
# ---------------------------------------------------------------------------


class RefKind(enum.Enum):
    """How a lineage node contributes to its parent.

    VALUE means the node actually produces the value flowing upwards.
    PREDICATE means the node only appears in a filter / join / grouping
    condition and therefore influences which rows exist, not the value itself.
    """

    VALUE = "value"
    PREDICATE = "predicate"


@dataclass
class LineageNode:
    """One hop in a lineage path.

    A node is either:

    * a physical base-table column (``table`` + ``column`` set, ``block`` None),
    * the output column of an intermediate query block / view / CTE
      (``block`` + ``column`` set),
    * an unresolved leaf (``unresolved`` set) — these are deliberately kept in
      the tree instead of being dropped, so a failed resolution can never be
      mistaken for "no dependency".
    """

    kind: RefKind
    column: str
    table: Optional[str] = None
    block: Optional[str] = None
    expression: str = ""
    location: Optional[Location] = None
    children: list["LineageNode"] = field(default_factory=list)
    unresolved: Optional["UnresolvedItem"] = None
    # Operator / expression label shown at the intermediate step, e.g.
    # "concat ||", "SUM", "CASE", "scalar-subquery".
    transform: Optional[str] = None

    def is_base(self) -> bool:
        return self.block is None and self.table is not None and self.unresolved is None

    def to_dict(self) -> dict:
        return {
            "kind": self.kind.value,
            "column": self.column,
            "table": self.table,
            "block": self.block,
            "expression": self.expression,
            "transform": self.transform,
            "location": self.location.to_dict() if self.location else None,
            "unresolved": self.unresolved.to_dict() if self.unresolved else None,
            "children": [c.to_dict() for c in self.children],
        }


# ---------------------------------------------------------------------------
# Unresolved items
# ---------------------------------------------------------------------------


class UnresolvedKind(enum.Enum):
    AMBIGUOUS_COLUMN = "ambiguous_column"
    UNKNOWN_TABLE = "unknown_table"
    UNKNOWN_COLUMN = "unknown_column"
    UNRESOLVED_SYNTAX = "unresolved_syntax"
    UNSUPPORTED = "unsupported"
    STAR_EXPANSION = "star_expansion"
    RECURSIVE_CTE = "recursive_cte"
    STATEMENT_FAILURE = "statement_failure"


@dataclass
class UnresolvedItem:
    """Something the analyzer could not turn into concrete lineage.

    These are first-class outputs: requirement #4/#7 explicitly forbid silently
    guessing or counting unresolved pieces as having no dependencies.
    """

    kind: UnresolvedKind
    message: str
    location: Optional[Location] = None
    file: Optional[str] = None
    block_id: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "kind": self.kind.value,
            "message": self.message,
            "location": self.location.to_dict() if self.location else None,
            "file": self.file,
            "block_id": self.block_id,
        }


# ---------------------------------------------------------------------------
# Query block outputs and catalog entries
# ---------------------------------------------------------------------------


@dataclass
class OutputColumn:
    """One output column of a query block."""

    name: str
    ordinal: int
    expression: str
    location: Optional[Location]
    lineage: list[LineageNode]
    # Columns that only affect this output's rows (filter / join / group ...).
    predicate_deps: list[LineageNode] = field(default_factory=list)
    is_aggregate: bool = False
    is_expanded_from_star: bool = False
    # True when the expression references no base column at all (literal /
    # constant expression). This is distinct from an unresolved output.
    is_constant: bool = False

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "ordinal": self.ordinal,
            "expression": self.expression,
            "location": self.location.to_dict() if self.location else None,
            "lineage": [n.to_dict() for n in self.lineage],
            "predicate_deps": [n.to_dict() for n in self.predicate_deps],
            "is_aggregate": self.is_aggregate,
            "is_expanded_from_star": self.is_expanded_from_star,
            "is_constant": self.is_constant,
        }


class BlockKind(enum.Enum):
    SELECT = "select"
    VIEW = "view"
    CREATE_TABLE_AS = "create_table_as"
    CTE = "cte"
    SUBQUERY = "subquery"
    SETOP = "setop"


@dataclass
class QueryBlock:
    """A named, addressable relation-producing step.

    ``block_id`` is globally unique (file path + statement ordinal + nested
    chain). ``name`` is the name visible inside its containing scope (CTE
    alias, view name, ...); nested blocks with the same name get distinct ids
    so scopes can never cross-link.
    """

    block_id: str
    name: str
    kind: BlockKind
    file: str
    location: Optional[Location]
    output_columns: list[OutputColumn]
    # block ids this block reads from (FROM / JOIN), in textual order.
    referenced_blocks: list[str] = field(default_factory=list)
    # base tables read by this block, "schema.table" style names.
    referenced_tables: list[str] = field(default_factory=list)
    unresolved: list[UnresolvedItem] = field(default_factory=list)
    # Predicate-only dependencies that are not attached to a single output
    # column (e.g. WHERE on a SELECT *). Stored as lineage nodes whose kind is
    # PREDICATE and whose children explain the expression.
    block_predicate_deps: list[LineageNode] = field(default_factory=list)
    parent_block_id: Optional[str] = None
    unsupported: bool = False

    def to_dict(self) -> dict:
        return {
            "block_id": self.block_id,
            "name": self.name,
            "kind": self.kind.value,
            "file": self.file,
            "location": self.location.to_dict() if self.location else None,
            "output_columns": [c.to_dict() for c in self.output_columns],
            "referenced_blocks": self.referenced_blocks,
            "referenced_tables": self.referenced_tables,
            "unresolved": [u.to_dict() for u in self.unresolved],
            "block_predicate_deps": [n.to_dict() for n in self.block_predicate_deps],
            "parent_block_id": self.parent_block_id,
            "unsupported": self.unsupported,
        }


@dataclass
class StatementResult:
    """Result of analyzing one top-level statement in a file."""

    file: str
    ordinal: int
    sql: str
    block_ids: list[str] = field(default_factory=list)
    # Name registered into the cross-query catalog, if any (view / CTAS / ...).
    registered_name: Optional[str] = None
    registered_block_id: Optional[str] = None
    unresolved: list[UnresolvedItem] = field(default_factory=list)
    parse_failed: bool = False

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "ordinal": self.ordinal,
            "sql": self.sql,
            "block_ids": self.block_ids,
            "registered_name": self.registered_name,
            "registered_block_id": self.registered_block_id,
            "unresolved": [u.to_dict() for u in self.unresolved],
            "parse_failed": self.parse_failed,
        }


@dataclass
class FileResult:
    file: str
    statements: list[StatementResult] = field(default_factory=list)
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "statements": [s.to_dict() for s in self.statements],
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TableSchema:
    name: str
    columns: tuple[str, ...]

    def to_dict(self) -> dict:
        return {"name": self.name, "columns": list(self.columns)}


# ---------------------------------------------------------------------------
# Impact (reverse lookup)
# ---------------------------------------------------------------------------


@dataclass
class ImpactPath:
    """One flattened chain from a base column up to an affected output."""

    block_id: str
    block_name: str
    output_column: str
    output_ordinal: int
    output_location: Optional[Location]
    # Ordered hops: base column -> intermediate block outputs -> final output.
    hops: list[LineageNode]

    def to_dict(self) -> dict:
        return {
            "block_id": self.block_id,
            "block_name": self.block_name,
            "output_column": self.output_column,
            "output_ordinal": self.output_ordinal,
            "output_location": (
                self.output_location.to_dict() if self.output_location else None
            ),
            "hops": [h.to_dict() for h in self.hops],
        }


@dataclass
class FieldImpact:
    """Reverse-lookup result for one base-table column."""

    table: str
    column: str
    # Outputs whose *value* derives from the field.
    value_impacts: list[ImpactPath] = field(default_factory=list)
    # Outputs / blocks whose rows are only filtered/joined/grouped by the field.
    predicate_impacts: list[ImpactPath] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "table": self.table,
            "column": self.column,
            "value_impacts": [p.to_dict() for p in self.value_impacts],
            "predicate_impacts": [p.to_dict() for p in self.predicate_impacts],
        }


LineageLeaf = Union[LineageNode, UnresolvedItem]
