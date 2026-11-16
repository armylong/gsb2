"""Static SQL field-lineage analyzer (sqlite dialect).

Design summary
==============

Every relation visible inside a query block is represented by a
:class:`Binding` (base table, CTE / view / subquery output). A :class:`Scope`
holds the bindings of one query block plus a parent pointer, which gives
lexical scoping: a CTE named ``x`` inside a nested block shadows an outer ``x``
and the two can never cross-link.

Column resolution is computed explicitly:

* qualified columns (``t.col``) must match exactly one binding;
* unqualified columns must match exactly one in-scope binding — a match in more
  than one binding is reported as an *ambiguous* unresolved item;
* ``*`` / ``t.*`` is expanded from the schema / inner block outputs;
* anything that cannot be resolved becomes an :class:`UnresolvedItem` leaf that
  stays inside the lineage tree, so unresolved work is never silently counted
  as "no dependency".

Two dependency roles are kept apart on every lineage node:

* ``value``     — produces the column value;
* ``predicate`` — only filters / joins / groups the rows.

The module parses SQL but never executes it and never opens a database.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import count
from typing import Optional

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from .locations import node_location, parse_error_location
from .models import (
    BlockKind,
    LineageNode,
    Location,
    OutputColumn,
    QueryBlock,
    RefKind,
    StatementResult,
    UnresolvedItem,
    UnresolvedKind,
)
from .schema import SchemaCatalog, normalize_name, table_key


class UnsupportedError(Exception):
    """Raised for statement shapes deliberately out of scope."""


class _Locator:
    """Translates statement-relative AST positions to absolute file positions.

    sqlglot node positions are relative to the statement substring that was
    parsed. A script contains many statements at different offsets, and blocks
    can be shared across statements via lineage cloning, so every location is
    normalized once, at creation time, to coordinates in the full file text.
    """

    def __init__(
        self, file: str, statement_text: str, base_offset: int, full_text: str
    ):
        self.file = file
        self._statement_text = statement_text
        self._base_offset = base_offset
        self._full_text = full_text

    def node(self, node: exp.Expression | None) -> Optional[Location]:
        relative = node_location(node, self.file, self._statement_text)
        return self._absolutize(relative)

    def parse_error(self, error: Exception) -> Optional[Location]:
        relative = parse_error_location(error, self.file, self._statement_text)
        return self._absolutize(relative)

    def _absolutize(self, relative: Optional[Location]) -> Optional[Location]:
        if relative is None:
            return None
        start = self._base_offset + relative.start
        end = self._base_offset + relative.end
        snippet = self._full_text[start:end].strip() or relative.snippet
        line = self._full_text.count("\n", 0, start) + 1
        line_start = self._full_text.rfind("\n", 0, start) + 1
        col = start - line_start + 1
        return Location(
            file=self.file,
            line=line,
            col=col,
            start=start,
            end=end,
            snippet=" ".join(snippet.split())[:200],
        )


# ---------------------------------------------------------------------------
# Bindings and scopes
# ---------------------------------------------------------------------------


@dataclass
class Binding:
    """A relation accessible by name inside a scope."""

    alias: str
    kind: str  # "table" | "block" | "unknown_table"
    location: Optional[Location] = None
    # table binding
    table_name: Optional[str] = None
    table_display: Optional[str] = None
    # block binding
    block_id: Optional[str] = None
    block_outputs: Optional[list[OutputColumn]] = None

    def has_column(self, analyzer: "Analyzer", normalized_column: str) -> bool:
        if self.kind == "table":
            schema = analyzer.catalog.resolve_table_by_binding(self)
            return schema is not None and any(
                normalize_name(c) == normalized_column for c in schema.columns
            )
        if self.kind == "block":
            return any(
                normalize_name(out.name) == normalized_column
                for out in (self.block_outputs or [])
            )
        return False


class Scope:
    """Lexical binding environment for one query block."""

    def __init__(
        self,
        analyzer: "Analyzer",
        block_id: str,
        parent: Optional["Scope"] = None,
    ):
        self.analyzer = analyzer
        self.block_id = block_id
        self.parent = parent
        self.bindings: list[Binding] = []

    def add_binding(self, binding: Binding) -> None:
        self.bindings.append(binding)

    def find_binding(self, alias: str) -> Optional[Binding]:
        """Innermost scope first — inner CTE names shadow outer ones."""

        wanted = normalize_name(alias)
        for binding in self.bindings:
            if normalize_name(binding.alias) == wanted:
                return binding
        if self.parent is not None:
            return self.parent.find_binding(alias)
        return None

    def unqualified_matches(self, column: str) -> list[Binding]:
        wanted = normalize_name(column)
        return [
            binding
            for binding in self.bindings
            if binding.has_column(self.analyzer, wanted)
        ]


# ---------------------------------------------------------------------------
# Analyzer
# ---------------------------------------------------------------------------


class Analyzer:
    def __init__(self, catalog: SchemaCatalog):
        self.catalog = catalog
        self.blocks: dict[str, QueryBlock] = {}
        # block display name -> block id, populated as statements are analyzed
        # in file order so later statements can reference views/CTAS.
        self.global_registry: dict[str, str] = {}
        self._seq = count(1)

    def _new_block_id(self, file: str, kind: str, label: str) -> str:
        return f"{file}#{kind}:{label}@{next(self._seq)}"

    # ======================================================================
    # Statement entry point
    # ======================================================================

    def analyze_statement(
        self,
        text: str,
        file: str,
        source_text: str,
        base_offset: int = 0,
        full_text: str | None = None,
    ) -> StatementResult:
        # When a statement is a substring of a larger script, positions are
        # translated to absolute offsets in the full file so cross-statement
        # block sharing never double-counts offsets.
        self._locator = _Locator(
            file=file,
            statement_text=text,
            base_offset=base_offset,
            full_text=full_text if full_text is not None else text,
        )
        result = StatementResult(file=file, ordinal=-1, sql=text.strip())
        try:
            parsed = sqlglot.parse_one(text, read="sqlite")
        except ParseError as exc:
            result.parse_failed = True
            result.unresolved.append(
                UnresolvedItem(
                    kind=UnresolvedKind.STATEMENT_FAILURE,
                    message=f"SQL cannot be parsed: {exc}",
                    location=self._locator.parse_error(exc),
                    file=file,
                )
            )
            return result

        if parsed is None:
            return result

        try:
            self._dispatch(parsed, file, source_text, result, parent_scope=None)
        except UnsupportedError as exc:
            result.unresolved.append(
                UnresolvedItem(
                    kind=UnresolvedKind.UNSUPPORTED,
                    message=str(exc),
                    location=self._locator.node(parsed),
                    file=file,
                )
            )
        return result

    def _loc(self, node: exp.Expression | None, file: str, source_text: str):
        """Locate a node in absolute file coordinates."""

        locator = getattr(self, "_locator", None)
        if locator is not None and locator.file == file:
            return locator.node(node)
        # Fallback for callers outside a statement analysis context.
        return node_location(node, file, source_text)

    def _dispatch(
        self,
        node: exp.Expression,
        file: str,
        source_text: str,
        result: StatementResult,
        parent_scope: Optional[Scope],
    ) -> None:
        if isinstance(node, (exp.Select, exp.Union, exp.Except, exp.Intersect)):
            kind = (
                BlockKind.SELECT
                if isinstance(node, exp.Select)
                else BlockKind.SETOP
            )
            block = self._analyze_relation(
                node, file, source_text, parent_scope, block_kind=kind
            )
            result.block_ids.append(block.block_id)
        elif isinstance(node, exp.Subquery):
            block = self._analyze_relation(
                node.this, file, source_text, parent_scope
            )
            result.block_ids.append(block.block_id)
        elif isinstance(node, exp.Create):
            self._analyze_create(node, file, source_text, result, parent_scope)
        elif isinstance(node, exp.Insert):
            raise UnsupportedError(
                "INSERT ... SELECT is not supported for field lineage; "
                "extract the SELECT into a view/query file instead"
            )
        elif isinstance(node, (exp.Update, exp.Delete)):
            raise UnsupportedError(
                f"{type(node).__name__} statements do not produce output fields "
                "and are outside the supported read-only query scope"
            )
        else:
            raise UnsupportedError(
                f"statement type {type(node).__name__} is not supported"
            )

    def _analyze_relation(
        self,
        node: exp.Expression,
        file: str,
        source_text: str,
        parent_scope: Optional[Scope],
        block_name: Optional[str] = None,
        block_kind: BlockKind = BlockKind.SUBQUERY,
    ) -> QueryBlock:
        if isinstance(node, (exp.Union, exp.Except, exp.Intersect)):
            return self._analyze_setop(
                node, file, source_text, parent_scope, block_name, block_kind
            )
        return self._analyze_query(
            node, file, source_text, parent_scope, block_name, block_kind
        )

    # ======================================================================
    # CREATE VIEW / CREATE TABLE AS
    # ======================================================================

    def _analyze_create(
        self,
        node: exp.Create,
        file: str,
        source_text: str,
        result: StatementResult,
        parent_scope: Optional[Scope],
    ) -> None:
        kind = (node.args.get("kind") or "").upper()
        body = node.this
        # CREATE TABLE with a column list and no SELECT = plain DDL.
        if isinstance(body, exp.Schema) and node.expression is None:
            return
        if kind not in ("VIEW", "TABLE"):
            raise UnsupportedError("unsupported CREATE statement shape")

        # CREATE VIEW name(cols) AS SELECT ... parses as a Schema wrapping a
        # Table; without an explicit list the body is the Table directly.
        if isinstance(body, exp.Schema):
            table = body.this
            explicit_nodes = body.expressions
        elif isinstance(body, exp.Table):
            table = body
            explicit_nodes = []
        else:
            raise UnsupportedError("unsupported CREATE statement shape")

        select = node.expression
        if select is None:
            raise UnsupportedError("CREATE without a SELECT body is not supported")

        block = self._analyze_relation(
            select,
            file,
            source_text,
            parent_scope,
            block_name=table.sql(dialect="sqlite"),
            block_kind=BlockKind.VIEW if kind == "VIEW" else BlockKind.CREATE_TABLE_AS,
        )
        result.block_ids.append(block.block_id)

        explicit = [col.name for col in explicit_nodes]
        if explicit:
            if len(explicit) != len(block.output_columns):
                block.unresolved.append(
                    UnresolvedItem(
                        kind=UnresolvedKind.UNRESOLVED_SYNTAX,
                        message=(
                            f"explicit column list has {len(explicit)} names but "
                            f"the query produces {len(block.output_columns)} columns"
                        ),
                        location=self._loc(table, file, source_text),
                        file=file,
                        block_id=block.block_id,
                    )
                )
            else:
                for output, new_name in zip(block.output_columns, explicit):
                    output.name = new_name

        registered = table.sql(dialect="sqlite")
        result.registered_name = registered
        result.registered_block_id = block.block_id
        self.global_registry[normalize_name(registered)] = block.block_id

    # ======================================================================
    # SELECT blocks
    # ======================================================================

    def _analyze_query(
        self,
        select: exp.Select,
        file: str,
        source_text: str,
        parent_scope: Optional[Scope],
        block_name: Optional[str],
        block_kind: BlockKind,
    ) -> QueryBlock:
        label = block_name or "q"
        block_id = self._new_block_id(file, block_kind.value, label)
        scope = Scope(self, block_id=block_id, parent=parent_scope)
        block = QueryBlock(
            block_id=block_id,
            name=block_name or block_id,
            kind=block_kind,
            file=file,
            location=self._loc(select, file, source_text),
            output_columns=[],
            parent_block_id=parent_scope.block_id if parent_scope else None,
        )

        # 1) CTEs — registered in this scope; inner names shadow outer ones.
        self._register_ctes(select, file, source_text, scope, block)

        # 2) FROM + JOIN bindings (and nested subquery blocks).
        self._register_from(select, file, source_text, scope, block)

        # 3) Output projections.
        self._build_projections(select, file, source_text, scope, block)

        # 4) Predicate-only clauses.
        self._build_predicates(select, file, source_text, scope, block)

        self.blocks[block_id] = block
        return block

    # -- CTEs --------------------------------------------------------------

    def _register_ctes(
        self,
        select: exp.Select,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
    ) -> None:
        for cte in select.ctes:
            label = cte.alias or "cte"
            location = self._loc(cte, file, source_text)
            recursive = bool(cte.args.get("recursive")) or self._cte_self_references(
                cte
            )

            if recursive:
                # Unsupported placeholder: references resolve to an explicit
                # marker instead of silently inventing lineage.
                rec_id = self._new_block_id(file, BlockKind.CTE.value, label)
                rec_block = QueryBlock(
                    block_id=rec_id,
                    name=label,
                    kind=BlockKind.CTE,
                    file=file,
                    location=location,
                    output_columns=[],
                    parent_block_id=block.block_id,
                    unsupported=True,
                )
                rec_block.unresolved.append(
                    UnresolvedItem(
                        kind=UnresolvedKind.RECURSIVE_CTE,
                        message=(
                            f"recursive CTE '{label}' is not supported; references "
                            "to it are marked unresolved (no cycle is followed)"
                        ),
                        location=location,
                        file=file,
                        block_id=rec_id,
                    )
                )
                self.blocks[rec_id] = rec_block
                scope.add_binding(
                    Binding(
                        alias=label,
                        kind="block",
                        location=location,
                        block_id=rec_id,
                        block_outputs=[],
                    )
                )
                continue

            inner_block = self._analyze_relation(
                cte.this,
                file,
                source_text,
                scope,
                block_name=label,
                block_kind=BlockKind.CTE,
            )

            # Explicit CTE column list: WITH c(a, b) AS (...)
            explicit = [
                col.name for col in cte.args.get("key_expressions") or []
            ]
            if explicit and len(explicit) == len(inner_block.output_columns):
                for output, new_name in zip(inner_block.output_columns, explicit):
                    output.name = new_name

            scope.add_binding(
                Binding(
                    alias=label,
                    kind="block",
                    location=location,
                    block_id=inner_block.block_id,
                    block_outputs=inner_block.output_columns,
                )
            )

    def _cte_self_references(self, cte: exp.CTE) -> bool:
        name = normalize_name(cte.alias)
        return any(
            normalize_name(table.name) == name
            for table in cte.this.find_all(exp.Table)
        )

    # -- FROM / JOIN -------------------------------------------------------

    def _register_from(
        self,
        select: exp.Select,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
    ) -> None:
        # In sqlglot 30 the primary FROM table lives in From.this; comma joins
        # are represented as additional CROSS JOIN entries in select.joins.
        from_ = select.args.get("from_")
        if from_ is not None and from_.this is not None:
            self._register_source(from_.this, file, source_text, scope, block)

        for join in select.args.get("joins") or []:
            self._register_source(join.this, file, source_text, scope, block)
            on = join.args.get("on")
            if on is not None:
                block.block_predicate_deps.extend(
                    self._predicate_nodes(on, file, source_text, scope, block)
                )
            for using_col in join.args.get("using") or []:
                block.block_predicate_deps.extend(
                    self._predicate_nodes(
                        using_col, file, source_text, scope, block
                    )
                )

    def _register_source(
        self,
        source: exp.Expression,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
    ) -> None:
        if isinstance(source, exp.Subquery):
            label = source.alias or f"subq_{len(scope.bindings) + 1}"
            inner_block = self._analyze_relation(
                source.this,
                file,
                source_text,
                scope,
                block_name=label,
                block_kind=BlockKind.SUBQUERY,
            )
            block.referenced_blocks.append(inner_block.block_id)
            scope.add_binding(
                Binding(
                    alias=label,
                    kind="block",
                    location=self._loc(source, file, source_text),
                    block_id=inner_block.block_id,
                    block_outputs=inner_block.output_columns,
                )
            )
        elif isinstance(source, exp.Table):
            self._register_table(source, file, source_text, scope, block)
        else:
            block.unresolved.append(
                UnresolvedItem(
                    kind=UnresolvedKind.UNSUPPORTED,
                    message=f"unsupported FROM source: {source.sql()}",
                    location=self._loc(source, file, source_text),
                    file=file,
                    block_id=block.block_id,
                )
            )

    def _register_table(
        self,
        table: exp.Table,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
    ) -> None:
        alias = table.alias or table.name
        location = self._loc(table, file, source_text)

        # A CTE in scope takes precedence over any catalog / view name.
        cte_binding = scope.find_binding(table.name)
        if cte_binding is not None and cte_binding.kind == "block":
            block.referenced_blocks.append(cte_binding.block_id)
            if normalize_name(alias) == normalize_name(cte_binding.alias):
                # `FROM cte_name` without an alias reuses the CTE's own binding
                # instead of registering a second binding of the same name.
                return
            scope.add_binding(
                Binding(
                    alias=alias,
                    kind="block",
                    location=location,
                    block_id=cte_binding.block_id,
                    block_outputs=cte_binding.block_outputs,
                )
            )
            return

        # A table name may also refer to a view/CTAS registered earlier.
        registered_id = self.global_registry.get(
            table_key(table.db or None, table.name)
        ) or self.global_registry.get(normalize_name(table.name))
        if registered_id is not None:
            target = self.blocks[registered_id]
            block.referenced_blocks.append(registered_id)
            scope.add_binding(
                Binding(
                    alias=alias,
                    kind="block",
                    location=location,
                    block_id=registered_id,
                    block_outputs=target.output_columns,
                )
            )
            return

        schema = self.catalog.resolve_table(table)
        if schema is None:
            block.unresolved.append(
                UnresolvedItem(
                    kind=UnresolvedKind.UNKNOWN_TABLE,
                    message=(
                        f"table '{table.sql(dialect='sqlite')}' is not present in "
                        "the schema input; columns from it cannot be resolved"
                    ),
                    location=location,
                    file=file,
                    block_id=block.block_id,
                )
            )
            scope.add_binding(
                Binding(
                    alias=alias,
                    kind="unknown_table",
                    location=location,
                    table_name=table_key(table.db or None, table.name),
                    table_display=table.sql(dialect="sqlite"),
                )
            )
            return

        block.referenced_tables.append(schema.name)
        scope.add_binding(
            Binding(
                alias=alias,
                kind="table",
                location=location,
                table_name=table_key(table.db or None, table.name),
                table_display=schema.name,
            )
        )

    # -- projections --------------------------------------------------------

    def _build_projections(
        self,
        select: exp.Select,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
    ) -> None:
        ordinal = 0
        for projection in select.expressions:
            if isinstance(projection, (exp.Star, exp.Column)) and projection.is_star:
                for output in self._expand_star(
                    projection, file, source_text, scope, block
                ):
                    ordinal += 1
                    output.ordinal = ordinal
                    block.output_columns.append(output)
                continue

            ordinal += 1
            location = self._loc(projection, file, source_text)
            name = self._projection_name(projection)
            lineage = self._value_nodes(
                projection, file, source_text, scope, block
            )
            if not _references_any_column(projection):
                is_constant = True
            else:
                is_constant = False
            block.output_columns.append(
                OutputColumn(
                    name=name,
                    ordinal=ordinal,
                    expression=projection.sql(dialect="sqlite"),
                    location=location,
                    lineage=lineage,
                    is_aggregate=bool(projection.find(exp.AggFunc)),
                    is_constant=is_constant,
                )
            )

    def _projection_name(self, projection: exp.Expression) -> str:
        if projection.alias:
            return projection.alias
        if isinstance(projection, exp.Column):
            return projection.name
        return projection.sql(dialect="sqlite")

    def _expand_star(
        self,
        star: exp.Expression,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
    ) -> list[OutputColumn]:
        qualifier = star.table if isinstance(star, exp.Column) else ""
        location = self._loc(star, file, source_text)
        outputs: list[OutputColumn] = []

        if qualifier:
            binding = scope.find_binding(qualifier)
            if binding is None:
                block.unresolved.append(
                    UnresolvedItem(
                        kind=UnresolvedKind.STAR_EXPANSION,
                        message=(
                            f"cannot expand '{star.sql()}': no table or alias "
                            f"named '{qualifier}' is in scope"
                        ),
                        location=location,
                        file=file,
                        block_id=block.block_id,
                    )
                )
                return outputs
            candidates = [binding]
        else:
            candidates = list(scope.bindings)

        for binding in candidates:
            for column_name in self._binding_column_names(binding):
                col_expr = exp.column(column_name, table=binding.alias)
                lineage = self._value_nodes(
                    col_expr, file, source_text, scope, block
                )
                outputs.append(
                    OutputColumn(
                        name=column_name,
                        ordinal=0,
                        expression=(
                            f"{binding.alias}.{column_name} (expanded from "
                            f"{star.sql(dialect='sqlite')})"
                        ),
                        location=location,
                        lineage=lineage,
                        is_expanded_from_star=True,
                    )
                )

        if not outputs:
            block.unresolved.append(
                UnresolvedItem(
                    kind=UnresolvedKind.STAR_EXPANSION,
                    message=(
                        f"'{star.sql(dialect='sqlite')}' expanded to zero columns; "
                        "the target relation has no known structure"
                    ),
                    location=location,
                    file=file,
                    block_id=block.block_id,
                )
            )
        return outputs

    def _binding_column_names(self, binding: Binding) -> list[str]:
        if binding.kind == "table":
            schema = self.catalog.resolve_table_by_binding(binding)
            return list(schema.columns) if schema else []
        if binding.kind == "block":
            return [out.name for out in (binding.block_outputs or [])]
        return []

    # -- predicate clauses --------------------------------------------------

    def _build_predicates(
        self,
        select: exp.Select,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
    ) -> None:
        where = select.args.get("where")
        if where is not None:
            block.block_predicate_deps.extend(
                self._predicate_nodes(where.this, file, source_text, scope, block)
            )

        having = select.args.get("having")
        if having is not None:
            # A bare output alias inside HAVING resolves to the output itself;
            # the generic column resolver handles that via _match_output_alias.
            block.block_predicate_deps.extend(
                self._predicate_nodes(having.this, file, source_text, scope, block)
            )

        group = select.args.get("group")
        if group is not None:
            for grouped in group.expressions:
                if isinstance(grouped, exp.Column) and self._match_output_alias(
                    grouped, block
                ):
                    continue
                block.block_predicate_deps.extend(
                    self._predicate_nodes(
                        grouped, file, source_text, scope, block
                    )
                )

        if select.args.get("distinct") is not None:
            # DISTINCT makes every output column part of the row-identity key.
            for projection in select.expressions:
                if isinstance(projection, (exp.Star, exp.Column)) and projection.is_star:
                    continue
                block.block_predicate_deps.extend(
                    self._predicate_nodes(
                        projection, file, source_text, scope, block
                    )
                )

        order = select.args.get("order")
        if order is not None:
            for ordered in order.expressions:
                inner = ordered.this
                if isinstance(inner, exp.Column) and self._match_output_alias(
                    inner, block
                ):
                    continue
                block.block_predicate_deps.extend(
                    self._predicate_nodes(
                        inner, file, source_text, scope, block
                    )
                )

        # Block-level filters change which rows EVERY output contains, so each
        # output carries them as predicate-only refs (never as value refs).
        for output in block.output_columns:
            output.predicate_deps = clone_predicate_tree(
                block.block_predicate_deps
            )

    def _match_output_alias(
        self, column: exp.Expression, block: QueryBlock
    ) -> Optional[OutputColumn]:
        if isinstance(column, exp.Column) and not column.table:
            wanted = normalize_name(column.name)
            for output in block.output_columns:
                if normalize_name(output.name) == wanted:
                    return output
        return None

    def _unsupported_binding(self, scope: Scope) -> Optional[Binding]:
        """Return an in-scope block binding that is unsupported (recursive)."""

        current: Optional[Scope] = scope
        while current is not None:
            for binding in current.bindings:
                if binding.kind != "block" or not binding.block_id:
                    continue
                target = self.blocks.get(binding.block_id)
                if target is not None and target.unsupported:
                    return binding
            current = current.parent
        return None

    # ======================================================================
    # Expression -> lineage nodes
    # ======================================================================

    def _value_nodes(
        self, expression: exp.Expression, file: str, source_text: str,
        scope: Scope, block: QueryBlock,
    ) -> list[LineageNode]:
        return self._lineage_nodes(
            expression, file, source_text, scope, block, RefKind.VALUE
        )

    def _predicate_nodes(
        self, expression: exp.Expression, file: str, source_text: str,
        scope: Scope, block: QueryBlock,
    ) -> list[LineageNode]:
        return self._lineage_nodes(
            expression, file, source_text, scope, block, RefKind.PREDICATE
        )

    def _lineage_nodes(
        self,
        expression: exp.Expression,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
        role: RefKind,
    ) -> list[LineageNode]:
        if expression is None:
            return []

        # ---- leaves -------------------------------------------------------
        if isinstance(expression, exp.Column):
            if expression.is_star:
                return [
                    self._unresolved_node(
                        UnresolvedKind.STAR_EXPANSION,
                        f"unexpected star inside expression: {expression.sql()}",
                        expression, file, source_text, block, role,
                    )
                ]
            return [
                self._resolve_column(
                    expression, file, source_text, scope, block, role
                )
            ]

        if isinstance(expression, exp.Star):
            # count(*) / similar aggregate stars count rows without reading a
            # concrete column, so they carry no field lineage.
            if isinstance(expression.parent, exp.AggFunc):
                return []
            return [
                self._unresolved_node(
                    UnresolvedKind.STAR_EXPANSION,
                    "bare '*' is only supported at the SELECT projection level",
                    expression, file, source_text, block, role,
                )
            ]

        if isinstance(expression, exp.Literal):
            return []

        if isinstance(expression, (exp.Null, exp.Boolean)):
            return []

        # ---- subqueries ---------------------------------------------------
        if isinstance(expression, exp.Exists):
            return [
                self._subquery_node(
                    expression.this, file, source_text, scope, block, role,
                    prefix="EXISTS",
                )
            ]
        if isinstance(expression, exp.Subquery):
            return [
                self._subquery_node(
                    expression, file, source_text, scope, block, role
                )
            ]

        # ---- CASE: WHEN conditions are predicates, THEN/ELSE are values ----
        if isinstance(expression, exp.Case):
            return self._case_nodes(
                expression, file, source_text, scope, block, role
            )

        # ---- WINDOW: the function is the value; PARTITION BY / ORDER BY
        # only decide which rows the window sees ----------------------------
        if isinstance(expression, exp.Window):
            return self._window_nodes(
                expression, file, source_text, scope, block, role
            )

        # ---- generic composite: recurse, then wrap when informative -------
        child_nodes: list[LineageNode] = []
        for child in expression.iter_expressions():
            child_nodes.extend(
                self._lineage_nodes(
                    child, file, source_text, scope, block, role
                )
            )
        if not child_nodes:
            return []

        transform = transform_label(expression)
        if transform is None:
            return child_nodes  # transparent wrapper (Alias, Paren, ...)

        return [
            LineageNode(
                kind=role,
                column=expression.sql(dialect="sqlite")[:120],
                expression=expression.sql(dialect="sqlite"),
                location=self._loc(expression, file, source_text),
                children=child_nodes,
                transform=transform,
            )
        ]

    def _case_nodes(
        self, case: exp.Case, file: str, source_text: str,
        scope: Scope, block: QueryBlock, role: RefKind,
    ) -> list[LineageNode]:
        children: list[LineageNode] = []
        # Simple CASE: CASE a WHEN 1 THEN ... — `a` only selects the branch.
        if case.args.get("this") is not None:
            children.extend(
                self._as_role(
                    self._lineage_nodes(
                        case.this, file, source_text, scope, block, RefKind.VALUE
                    ),
                    RefKind.PREDICATE,
                )
            )
        for if_node in case.args.get("ifs") or []:
            children.extend(
                self._as_role(
                    self._lineage_nodes(
                        if_node.this, file, source_text, scope, block, role
                    ),
                    RefKind.PREDICATE,
                )
            )
            true_expr = if_node.args.get("true")
            if true_expr is not None:
                children.extend(
                    self._lineage_nodes(
                        true_expr, file, source_text, scope, block, RefKind.VALUE
                    )
                )
        default = case.args.get("default")
        if default is not None:
            children.extend(
                self._lineage_nodes(
                    default, file, source_text, scope, block, RefKind.VALUE
                )
            )
        if not children:
            return []
        return [
            LineageNode(
                kind=role,
                column=case.sql(dialect="sqlite")[:120],
                expression=case.sql(dialect="sqlite"),
                location=self._loc(case, file, source_text),
                children=children,
                transform="CASE",
            )
        ]

    def _window_nodes(
        self, window: exp.Window, file: str, source_text: str,
        scope: Scope, block: QueryBlock, role: RefKind,
    ) -> list[LineageNode]:
        children: list[LineageNode] = []
        func = window.this
        if func is not None:
            children.extend(
                self._lineage_nodes(
                    func, file, source_text, scope, block, RefKind.VALUE
                )
            )
        for part in window.args.get("partition_by") or []:
            children.extend(
                self._lineage_nodes(
                    part, file, source_text, scope, block, RefKind.PREDICATE
                )
            )
        order = window.args.get("order")
        if order is not None:
            for ordered in order.expressions:
                children.extend(
                    self._lineage_nodes(
                        ordered.this, file, source_text, scope, block,
                        RefKind.PREDICATE,
                    )
                )
        if not children:
            return []
        return [
            LineageNode(
                kind=role,
                column=window.sql(dialect="sqlite")[:120],
                expression=window.sql(dialect="sqlite"),
                location=self._loc(window, file, source_text),
                children=children,
                transform="WINDOW",
            )
        ]

    @staticmethod
    def _as_role(nodes: list[LineageNode], role: RefKind) -> list[LineageNode]:
        clones = clone_tree(nodes)
        for node in clones:
            _force_role(node, role)
        return clones

    # -- column resolution --------------------------------------------------

    def _resolve_column(
        self,
        column: exp.Column,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
        role: RefKind,
    ) -> LineageNode:
        location = self._loc(column, file, source_text)
        qualifier = column.table
        name = column.name

        if qualifier:
            binding = scope.find_binding(qualifier)
            if binding is None:
                return self._unresolved_node(
                    UnresolvedKind.UNKNOWN_TABLE,
                    (
                        f"column '{column.sql(dialect='sqlite')}': no table or "
                        f"alias named '{qualifier}' is in scope"
                    ),
                    column, file, source_text, block, role,
                )
            return self._column_from_binding(
                binding, name, column, file, source_text, block, role, location
            )

        matches = scope.unqualified_matches(name)
        if len(matches) > 1:
            owners = ", ".join(binding.alias for binding in matches)
            return self._unresolved_node(
                UnresolvedKind.AMBIGUOUS_COLUMN,
                (
                    f"column '{name}' is ambiguous: it exists in "
                    f"{len(matches)} in-scope relations ({owners}); qualify it "
                    "with an alias"
                ),
                column, file, source_text, block, role,
            )
        if len(matches) == 1:
            return self._column_from_binding(
                matches[0], name, column, file, source_text, block, role, location
            )

        # Bare output alias (allowed in GROUP BY / ORDER BY / HAVING).
        alias_match = self._match_output_alias(column, block)
        if alias_match is not None:
            return LineageNode(
                kind=role,
                column=alias_match.name,
                block=block.block_id,
                expression=column.sql(dialect="sqlite"),
                location=location,
            )

        # A bare column against an in-scope unsupported block (e.g. a
        # recursive CTE) reports the real reason instead of unknown_column.
        unsupported = self._unsupported_binding(scope)
        if unsupported is not None:
            return self._unresolved_node(
                UnresolvedKind.RECURSIVE_CTE,
                (
                    f"column '{column.sql(dialect='sqlite')}' references "
                    f"unsupported recursive block '{unsupported.alias}'"
                ),
                column, file, source_text, block, role,
            )

        return self._unresolved_node(
            UnresolvedKind.UNKNOWN_COLUMN,
            (
                f"column '{name}' cannot be found in any in-scope table or "
                "query block"
            ),
            column, file, source_text, block, role,
        )

    def _column_from_binding(
        self,
        binding: Binding,
        name: str,
        column: exp.Column,
        file: str,
        source_text: str,
        block: QueryBlock,
        role: RefKind,
        location: Optional[Location],
    ) -> LineageNode:
        if binding.kind == "unknown_table":
            return self._unresolved_node(
                UnresolvedKind.UNKNOWN_TABLE,
                (
                    f"column '{column.sql(dialect='sqlite')}': relation "
                    f"'{binding.alias}' itself is unknown to the schema input"
                ),
                column, file, source_text, block, role,
            )

        if binding.kind == "table":
            schema = self.catalog.resolve_table_by_binding(binding)
            normalized = normalize_name(name)
            if schema is None or not any(
                normalize_name(c) == normalized for c in schema.columns
            ):
                return self._unresolved_node(
                    UnresolvedKind.UNKNOWN_COLUMN,
                    (
                        f"table '{binding.table_display or binding.alias}' has no "
                        f"column named '{name}'"
                    ),
                    column, file, source_text, block, role,
                )
            real_name = next(
                c for c in schema.columns if normalize_name(c) == normalized
            )
            return LineageNode(
                kind=role,
                column=real_name,
                table=schema.name,
                expression=column.sql(dialect="sqlite"),
                location=location,
            )

        # block binding (CTE / view / subquery): keep the full inner path.
        target = next(
            (
                out
                for out in (binding.block_outputs or [])
                if normalize_name(out.name) == normalize_name(name)
            ),
            None,
        )
        if target is None:
            if binding.block_id and self.blocks.get(binding.block_id) is not None \
                    and self.blocks[binding.block_id].unsupported:
                return self._unresolved_node(
                    UnresolvedKind.RECURSIVE_CTE,
                    (
                        f"column '{column.sql(dialect='sqlite')}' comes from the "
                        f"unsupported recursive block '{binding.alias}'"
                    ),
                    column, file, source_text, block, role,
                )
            return self._unresolved_node(
                UnresolvedKind.UNKNOWN_COLUMN,
                (
                    f"query block '{binding.alias}' has no output column named "
                    f"'{name}'"
                ),
                column, file, source_text, block, role,
            )

        return LineageNode(
            kind=role,
            column=target.name,
            block=binding.block_id,
            expression=column.sql(dialect="sqlite"),
            location=location,
            # The referenced block's own value tree is reused, but its role is
            # decided at THIS reference point: a column read inside a filter is
            # predicate-only all the way down, even if the block output itself
            # was computed as a value.
            children=clone_tree_as(target.lineage, role),
        )

    def _subquery_node(
        self,
        subquery: exp.Subquery,
        file: str,
        source_text: str,
        scope: Scope,
        block: QueryBlock,
        role: RefKind,
        prefix: str = "scalar-subquery",
    ) -> LineageNode:
        inner_block = self._analyze_relation(
            subquery.this
            if isinstance(subquery, exp.Subquery)
            else subquery,
            file,
            source_text,
            scope,
            block_name=None,
            block_kind=BlockKind.SUBQUERY,
        )
        block.referenced_blocks.append(inner_block.block_id)

        children: list[LineageNode] = []
        if inner_block.output_columns:
            first = inner_block.output_columns[0]
            children = clone_tree_as(first.lineage, role)
            # The inner block's own filters / joins / grouping decide which
            # rows the scalar result is computed from — keep them as
            # predicate-only branches of the subquery node.
            for predicate in clone_predicate_tree(
                inner_block.block_predicate_deps
            ):
                children.append(predicate)
            label = first.name
        else:
            label = "(no output)"
        return LineageNode(
            kind=role,
            column=label,
            block=inner_block.block_id,
            expression=subquery.sql(dialect="sqlite"),
            location=self._loc(subquery, file, source_text),
            children=children,
            transform=prefix,
        )

    def _unresolved_node(
        self,
        kind: UnresolvedKind,
        message: str,
        node: exp.Expression,
        file: str,
        source_text: str,
        block: QueryBlock,
        role: RefKind,
    ) -> LineageNode:
        item = UnresolvedItem(
            kind=kind,
            message=message,
            location=self._loc(node, file, source_text),
            file=file,
            block_id=block.block_id,
        )
        block.unresolved.append(item)
        return LineageNode(
            kind=role,
            column=f"<unresolved: {kind.value}>",
            expression=node.sql(dialect="sqlite"),
            location=item.location,
            unresolved=item,
        )

    # ======================================================================
    # Set operations (UNION / INTERSECT / EXCEPT) — aligned by ordinal
    # ======================================================================

    def _analyze_setop(
        self,
        node: exp.Expression,
        file: str,
        source_text: str,
        parent_scope: Optional[Scope],
        block_name: Optional[str],
        block_kind: BlockKind,
    ) -> QueryBlock:
        label = block_name or "setop"
        block_id = self._new_block_id(file, BlockKind.SETOP.value, label)
        block = QueryBlock(
            block_id=block_id,
            name=block_name or block_id,
            kind=BlockKind.SETOP,
            file=file,
            location=self._loc(node, file, source_text),
            output_columns=[],
            parent_block_id=parent_scope.block_id if parent_scope else None,
        )

        branch_blocks: list[QueryBlock] = []
        for branch in (node.left, node.right):
            relation = branch.this if isinstance(branch, exp.Subquery) else branch
            branch_blocks.append(
                self._analyze_relation(
                    relation, file, source_text, parent_scope,
                    block_name=None, block_kind=BlockKind.SUBQUERY,
                )
            )
            block.referenced_blocks.append(branch_blocks[-1].block_id)

        width = max((len(b.output_columns) for b in branch_blocks), default=0)
        for ordinal in range(width):
            children: list[LineageNode] = []
            # Output names follow the first branch (sqlite/standard set-op
            # semantics), even when later branches rename the same position.
            name = (
                branch_blocks[0].output_columns[ordinal].name
                if ordinal < len(branch_blocks[0].output_columns)
                else f"col_{ordinal + 1}"
            )
            location = None
            for index, branch_block in enumerate(branch_blocks):
                if ordinal >= len(branch_block.output_columns):
                    block.unresolved.append(
                        UnresolvedItem(
                            kind=UnresolvedKind.UNRESOLVED_SYNTAX,
                            message=(
                                f"set-operation branch outputs only "
                                f"{len(branch_block.output_columns)} columns; "
                                f"position {ordinal + 1} has no source on this "
                                "branch"
                            ),
                            location=branch_block.location,
                            file=file,
                            block_id=block_id,
                        )
                    )
                    continue
                source_output = branch_block.output_columns[ordinal]
                if ordinal == 0:
                    location = source_output.location
                if not source_output.lineage:
                    # Literal-only branch (e.g. SELECT 'x' AS t): record the
                    # constant explicitly instead of silently showing nothing.
                    child = LineageNode(
                        kind=RefKind.VALUE,
                        column=f"<constant> {source_output.expression}",
                        block=branch_block.block_id,
                        expression=source_output.expression,
                        location=source_output.location,
                        transform="constant",
                    )
                else:
                    child = LineageNode(
                        kind=RefKind.VALUE,
                        column=source_output.name,
                        block=branch_block.block_id,
                        expression=source_output.expression,
                        location=source_output.location,
                        children=clone_tree_as(source_output.lineage, RefKind.VALUE),
                        transform=f"branch#{index + 1}",
                    )
                children.append(child)

            block.output_columns.append(
                OutputColumn(
                    name=name,
                    ordinal=ordinal + 1,
                    expression=f"{type(node).__name__.upper()} output #{ordinal + 1}",
                    location=location,
                    lineage=[
                        LineageNode(
                            kind=RefKind.VALUE,
                            column=name,
                            block=block_id,
                            expression=type(node).__name__.upper(),
                            location=self._loc(node, file, source_text),
                            children=children,
                            transform=type(node).__name__.upper(),
                        )
                    ],
                )
            )

        self.blocks[block_id] = block
        return block


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _references_any_column(expression: exp.Expression) -> bool:
    """Whether an expression reads at least one real (non-star) column."""

    for column in expression.find_all(exp.Column):
        if not column.is_star:
            return True
    return False


def transform_label(expression: exp.Expression) -> Optional[str]:
    """Label for an intermediate expression hop; None means transparent."""

    if isinstance(expression, (exp.Alias, exp.Paren)):
        return None
    if isinstance(expression, exp.AggFunc):
        distinct = " DISTINCT" if expression.args.get("distinct") else ""
        return f"{type(expression).__name__.upper().replace('AGG', '')}{distinct}"
    if isinstance(expression, exp.Case):
        return "CASE"
    if isinstance(expression, exp.Window):
        return "WINDOW"
    if isinstance(expression, exp.Cast):
        return "CAST"
    if isinstance(expression, exp.Neg):
        return "NEG"
    if isinstance(expression, exp.Binary):
        return type(expression).__name__.upper()
    if isinstance(expression, exp.Func):
        return type(expression).__name__.upper()
    return "EXPR"


def clone_tree(nodes: list[LineageNode]) -> list[LineageNode]:
    """Deep-copy lineage nodes. Block outputs are shared by many consumers, so
    each reference gets its own copy to keep later role changes isolated."""

    clones: list[LineageNode] = []
    for node in nodes:
        clones.append(
            LineageNode(
                kind=node.kind,
                column=node.column,
                table=node.table,
                block=node.block,
                expression=node.expression,
                location=node.location,
                children=clone_tree(node.children),
                unresolved=node.unresolved,
                transform=node.transform,
            )
        )
    return clones


def clone_predicate_tree(nodes: list[LineageNode]) -> list[LineageNode]:
    clones = clone_tree(nodes)
    for node in clones:
        _force_role(node, RefKind.PREDICATE)
    return clones


def clone_tree_as(
    nodes: list[LineageNode], role: RefKind
) -> list[LineageNode]:
    """Deep-copy a block-output tree and re-role it for the reference point.

    The block's internal distinction (e.g. a CASE's value vs. condition child)
    is preserved inside the copy; this only rewrites the top-level chain so it
    matches whether the *reference* is a value read or a predicate read.
    """

    clones = clone_tree(nodes)
    for node in clones:
        _force_top_role(node, role)
    return clones


def _force_top_role(node: LineageNode, role: RefKind) -> None:
    node.kind = role
    for child in node.children:
        if role is RefKind.PREDICATE:
            # A column reached through a filter is predicate-only all the way
            # down to the base table.
            _force_role(child, RefKind.PREDICATE)
        elif child.kind is RefKind.VALUE:
            # Value references keep the block's internal predicate branches
            # (CASE conditions, window PARTITION BY) untouched.
            _force_top_role(child, RefKind.VALUE)


def _force_role(node: LineageNode, role: RefKind) -> None:
    node.kind = role
    for child in node.children:
        _force_role(child, role)
