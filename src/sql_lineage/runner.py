"""File-level analysis orchestration with per-statement failure isolation.

Each ``.sql`` query file is tokenized and split into statements. One statement
failing to parse (or hitting an unsupported construct) is recorded as an
unresolved item and the remaining statements in the same file — and every other
file — still produce full results. Unresolved items are therefore separate from
"no dependency": a failed statement never yields an empty, falsely-complete
lineage.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .analyzer import Analyzer
from .locations import split_statements
from .models import (
    FileResult,
    LineageNode,
    QueryBlock,
    UnresolvedItem,
)
from .schema import SchemaCatalog


@dataclass
class AnalysisResult:
    catalog: SchemaCatalog
    blocks: dict[str, QueryBlock]
    files: list[FileResult]
    schema_warnings: list[str] = field(default_factory=list)

    # -- convenience views -------------------------------------------------

    def all_unresolved(self) -> list[UnresolvedItem]:
        items: list[UnresolvedItem] = []
        for block in self.blocks.values():
            items.extend(block.unresolved)
        for file_result in self.files:
            for statement in file_result.statements:
                items.extend(statement.unresolved)
        return items

    def top_level_blocks(self) -> list[QueryBlock]:
        """Blocks produced directly by top-level statements (not nested)."""

        return [
            block
            for block in self.blocks.values()
            if block.parent_block_id is None
        ]

    def base_columns(self) -> list[tuple[str, str]]:
        seen: set[tuple[str, str]] = set()
        for block in self.blocks.values():
            for output in block.output_columns:
                _collect_base_columns(output.lineage, seen)
                _collect_base_columns(output.predicate_deps, seen)
            _collect_base_columns(block.block_predicate_deps, seen)
        return sorted(seen)

    def to_dict(self) -> dict:
        return {
            "schema": [t.to_dict() for t in self.catalog.all_tables()],
            "blocks": [
                self.blocks[k].to_dict()
                for k in sorted(self.blocks, key=lambda x: (self.blocks[x].file, x))
            ],
            "files": [f.to_dict() for f in self.files],
            "unresolved": [u.to_dict() for u in self.all_unresolved()],
            "schema_warnings": self.schema_warnings,
            "base_columns": [
                {"table": t, "column": c} for t, c in self.base_columns()
            ],
        }


def _collect_base_columns(
    nodes: list[LineageNode], seen: set[tuple[str, str]]
) -> None:
    for node in nodes:
        if node.is_base():
            seen.add((node.table or "", node.column))
        _collect_base_columns(node.children, seen)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


class LineageRunner:
    def __init__(self, catalog: SchemaCatalog | None = None) -> None:
        self.catalog = catalog or SchemaCatalog()

    def run(
        self,
        query_paths: list[str | Path],
        schema_paths: list[str | Path] | None = None,
        json_catalog_paths: list[str | Path] | None = None,
    ) -> AnalysisResult:
        warnings: list[str] = []
        for path in schema_paths or []:
            warnings.extend(self.catalog.load_ddl_file(path))
        for path in json_catalog_paths or []:
            warnings.extend(self.catalog.load_json_file(path))

        analyzer = Analyzer(self.catalog)
        file_results: list[FileResult] = []

        query_files = self._expand_query_paths(query_paths)
        for path in query_files:
            file_result = self._analyze_file(path, analyzer)
            file_results.append(file_result)

        return AnalysisResult(
            catalog=self.catalog,
            blocks=analyzer.blocks,
            files=file_results,
            schema_warnings=warnings,
        )

    @staticmethod
    def _expand_query_paths(
        query_paths: list[str | Path],
    ) -> list[Path]:
        collected: list[Path] = []
        for raw in query_paths:
            path = Path(raw)
            if path.is_dir():
                collected.extend(sorted(path.rglob("*.sql")))
            else:
                collected.append(path)
        seen: set[str] = set()
        unique: list[Path] = []
        for path in collected:
            key = str(path.resolve())
            if key not in seen:
                seen.add(key)
                unique.append(path)
        return unique

    def _analyze_file(self, path: Path, analyzer: Analyzer) -> FileResult:
        file_label = str(path)
        result = FileResult(file=file_label)
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            result.error = f"cannot read file: {exc}"
            return result

        raw_statements = split_statements(text)
        for index, raw in enumerate(raw_statements):
            statement = analyzer.analyze_statement(
                text=raw.text,
                file=file_label,
                source_text=raw.text,
                base_offset=raw.offset,
                full_text=text,
            )
            statement.ordinal = index
            # Locations are already emitted in absolute file coordinates by
            # the analyzer's locator, including nodes cloned from blocks owned
            # by earlier statements; no second remap pass is needed.
            result.statements.append(statement)

        return result
