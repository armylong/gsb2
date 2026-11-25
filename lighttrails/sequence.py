from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"}

_DIGITS_RE = re.compile(r"(\d+)(?!.*\d)")
_TOKEN_RE = re.compile(r"(\d+)")


def natural_key(path: str | Path) -> list[tuple[int, int, str]]:
    """Sort img2 before img10 while remaining total-ordered for mixed names."""
    name = Path(path).name
    key: list[tuple[int, int, str]] = []
    for part in _TOKEN_RE.split(name):
        if part == "":
            continue
        if part.isdigit():
            key.append((1, int(part), ""))
        else:
            key.append((0, 0, part.lower()))
    return key


def sort_paths(paths: Iterable[str | Path]) -> list[Path]:
    unique = {Path(p).expanduser().resolve() for p in paths}
    return sorted(unique, key=lambda p: (natural_key(p), str(p).lower()))


def trailing_number(path: str | Path) -> int | None:
    """Return the last run of digits in the file stem, if present."""
    stem = Path(path).stem
    match = _DIGITS_RE.search(stem)
    return int(match.group(1)) if match else None


def trailing_number_width(path: str | Path) -> int | None:
    stem = Path(path).stem
    match = _DIGITS_RE.search(stem)
    return len(match.group(1)) if match else None


@dataclass
class FrameItem:
    """One imported source frame.

    ``original_index`` is immutable and is assigned in sorted import order.
    ``source_number`` is the number embedded in the original filename; a
    missing file therefore creates a gap in ``source_number`` but never causes
    renumbering of imported rows.
    """

    original_index: int
    path: Path
    source_number: int | None = None
    number_width: int | None = None
    excluded: bool = False
    width: int | None = None
    height: int | None = None
    load_error: str | None = None
    tags: set[str] = field(default_factory=set)

    @property
    def file_name(self) -> str:
        return self.path.name

    @property
    def usable(self) -> bool:
        return self.load_error is None and self.width is not None and self.height is not None

    def display_number(self) -> str:
        if self.source_number is None:
            return str(self.original_index)
        width = self.number_width or 0
        return f"{self.source_number:0{width}d}" if width else str(self.source_number)


@dataclass(frozen=True)
class MissingGap:
    missing_number: int
    left_index: int | None
    right_index: int | None
    left_path: Path | None
    right_path: Path | None
    count: int = 1

    @property
    def single(self) -> bool:
        return self.count == 1

    def describe(self) -> str:
        if self.count == 1 and self.left_path and self.right_path:
            return (
                f"正中间缺少序号 {self.missing_number}："
                f"位于 {self.left_path.name} 与 {self.right_path.name} 之间"
            )
        if self.left_path and self.right_path:
            return (
                f"{self.left_path.name} 与 {self.right_path.name} 之间缺少 "
                f"{self.count} 张（首号 {self.missing_number}）"
            )
        return f"缺少序号 {self.missing_number}"


def make_frame_items(paths: Iterable[str | Path]) -> list[FrameItem]:
    items: list[FrameItem] = []
    for i, path in enumerate(sort_paths(paths), start=1):
        items.append(
            FrameItem(
                original_index=i,
                path=path,
                source_number=trailing_number(path),
                number_width=trailing_number_width(path),
            )
        )
    return items


def detect_missing_gaps(items: Sequence[FrameItem]) -> list[MissingGap]:
    """Detect numeric gaps between adjacent sorted frames.

    Only gaps bracketed by two imported frames are reported, so a sequence
    starting at 007 or ending early is not treated as a middle gap.
    """
    numbered = [item for item in items if item.source_number is not None]
    gaps: list[MissingGap] = []
    for left, right in zip(numbered, numbered[1:]):
        delta = int(right.source_number or 0) - int(left.source_number or 0)
        if delta <= 1:
            continue
        first_missing = int(left.source_number or 0) + 1
        gaps.append(
            MissingGap(
                missing_number=first_missing,
                left_index=left.original_index,
                right_index=right.original_index,
                left_path=left.path,
                right_path=right.path,
                count=delta - 1,
            )
        )
    return gaps


def scan_folder(folder: str | Path) -> list[Path]:
    root = Path(folder).expanduser()
    if not root.is_dir():
        raise NotADirectoryError(f"不是文件夹: {root}")
    paths = [p for p in root.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES]
    return sort_paths(paths)
