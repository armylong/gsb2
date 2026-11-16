"""Reverse impact: which outputs are affected by changing one base column.

Two relationship kinds are reported separately, mirroring requirement #3:

* **value impacts** — the base column's value flows into the output value
  (projection, expression, aggregate, UNION branch, ...);
* **predicate impacts** — the base column only decides which rows survive
  (WHERE / JOIN ON / USING / GROUP BY / HAVING / DISTINCT / window framing /
  CASE conditions).

Every impact carries the full hop chain with intermediate block outputs and
their SQL locations, satisfying the "full source path" requirement in both
directions.
"""

from __future__ import annotations

from .models import (
    FieldImpact,
    ImpactPath,
    LineageNode,
    OutputColumn,
    QueryBlock,
    RefKind,
)
from .schema import normalize_name


class ImpactAnalyzer:
    def __init__(self, blocks: dict[str, QueryBlock]):
        self.blocks = blocks

    # ======================================================================
    # Public API
    # ======================================================================

    def impact_of(self, table: str, column: str) -> FieldImpact:
        impact = FieldImpact(table=table, column=column)
        for block in self._blocks_in_dependency_order():
            for output in block.output_columns:
                # Predicate nodes can be nested inside value trees (CASE WHEN
                # conditions, window framing), so each tree is scanned for both
                # roles and classified by the matched node's own role.
                self._collect(
                    output.lineage,
                    block,
                    output,
                    table,
                    column,
                    impact,
                    visiting=set(),
                )
                self._collect(
                    output.predicate_deps,
                    block,
                    output,
                    table,
                    column,
                    impact,
                    visiting=set(),
                )
        self._dedup(impact.value_impacts)
        self._dedup(impact.predicate_impacts)
        return impact

    def all_impacts(self) -> dict[str, FieldImpact]:
        base_columns: set[tuple[str, str]] = set()
        for block in self.blocks.values():
            for output in block.output_columns:
                self._scan_base(output.lineage, base_columns)
                self._scan_base(output.predicate_deps, base_columns)
            self._scan_base(block.block_predicate_deps, base_columns)

        return {
            f"{table}.{column}": self.impact_of(table, column)
            for table, column in sorted(base_columns)
        }

    # ======================================================================
    # Traversal
    # ======================================================================

    def _collect(
        self,
        nodes: list[LineageNode],
        block: QueryBlock,
        output: OutputColumn,
        table: str,
        column: str,
        impact: FieldImpact,
        visiting: set[str],
        ancestors: list[LineageNode] | None = None,
    ) -> None:
        ancestors = ancestors if ancestors is not None else []
        for node in nodes:
            chain = ancestors + [node]
            if self._matches_base(node, table, column):
                sink = (
                    impact.value_impacts
                    if node.kind is RefKind.VALUE
                    else impact.predicate_impacts
                )
                sink.append(
                    ImpactPath(
                        block_id=block.block_id,
                        block_name=block.name,
                        output_column=output.name,
                        output_ordinal=output.ordinal,
                        output_location=output.location,
                        hops=self._build_hops(chain, block, output, visiting),
                    )
                )
            # Always descend: CASE/WINDOW trees deliberately mix both roles.
            self._collect(
                node.children, block, output, table, column, impact,
                visiting, chain,
            )

    def _build_hops(
        self,
        chain: list[LineageNode],
        block: QueryBlock,
        output: OutputColumn,
        visiting: set[str],
    ) -> list[LineageNode]:
        """Build the ordered chain base column -> ... -> block output.

        ``chain`` is the root-to-leaf path in the stored tree (output wrapper
        first, base column last). Block hops embed the referenced block's own
        output tree, so the chain already contains every intermediate
        transform and block; we reverse it and append the final output hop.
        """

        cycle_key = tuple(
            f"{n.block or ''}:{n.table or ''}:{n.column}:{n.transform or ''}"
            for n in chain
        )
        if cycle_key in visiting:
            return []
        visiting.add(cycle_key)

        hops = list(reversed(chain))
        hops.append(
            LineageNode(
                kind=chain[-1].kind,
                column=output.name,
                block=block.block_id,
                expression=output.expression,
                location=output.location,
            )
        )
        return hops

    def _matches_base(
        self, node: LineageNode, table: str, column: str
    ) -> bool:
        if not node.is_base():
            return False
        return (
            normalize_name(node.table or "") == normalize_name(table)
            and normalize_name(node.column) == normalize_name(column)
        )

    def _scan_base(
        self, nodes: list[LineageNode], sink: set[tuple[str, str]]
    ) -> None:
        for node in nodes:
            if node.is_base():
                sink.add((node.table or "", node.column))
            self._scan_base(node.children, sink)

    def _blocks_in_dependency_order(self) -> list[QueryBlock]:
        """Stable order: referenced blocks before referencing blocks.

        Ordering only affects presentation (and is deterministic); correctness
        of the reverse index does not depend on it.
        """

        ordered: list[QueryBlock] = []
        seen: set[str] = set()

        def visit(block_id: str) -> None:
            if block_id in seen or block_id not in self.blocks:
                return
            seen.add(block_id)
            block = self.blocks[block_id]
            for ref in block.referenced_blocks:
                visit(ref)
            ordered.append(block)

        for block_id in sorted(self.blocks):
            visit(block_id)
        return ordered

    @staticmethod
    def _dedup(paths: list[ImpactPath]) -> None:
        seen: set[tuple] = set()
        unique: list[ImpactPath] = []
        for path in paths:
            key = (
                path.block_id,
                path.output_ordinal,
                tuple(
                    (
                        h.kind.value,
                        h.table or "",
                        h.column,
                        h.block or "",
                        h.transform or "",
                    )
                    for h in path.hops
                ),
            )
            if key not in seen:
                seen.add(key)
                unique.append(path)
        paths[:] = unique
