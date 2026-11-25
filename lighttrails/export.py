from __future__ import annotations

import csv
from pathlib import Path
from typing import Sequence

from .engine import RoiContribution, StackParams, StackResult
from .sequence import FrameItem


def _range_bounds(items: Sequence[FrameItem], params: StackParams | None) -> tuple[int, int]:
    start = params.start if params else 1
    end = params.end if params and params.end is not None else max((i.original_index for i in items), default=start)
    return start, end


def _is_participating(item: FrameItem, start: int, end: int) -> bool:
    return bool(item.usable and start <= item.original_index <= end and not item.excluded)


def export_frame_list(
    path: str | Path,
    items: Sequence[FrameItem],
    params: StackParams | None = None,
    result: StackResult | None = None,
    roi_contributions: Sequence[RoiContribution] | None = None,
    include_all: bool = False,
) -> Path:
    """Export participating frames.

    The default file contains only usable, in-range, non-excluded frames.
    Set ``include_all=True`` to write an audit table with every imported row
    and its participation flag.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    effective_params = params or (result.params if result else None)
    start, end = _range_bounds(items, effective_params)
    roi_by_index = {c.original_index: c for c in roi_contributions or []}

    rows = list(items) if include_all else [item for item in items if _is_participating(item, start, end)]

    if target.suffix.lower() == ".txt":
        lines = [
            "# Light Trails 参与帧列表",
            f"# 范围: original_index {start}..{end}",
            f"# 参与帧数: {len([i for i in items if _is_participating(i, start, end)])}",
            "# 列: 原导入序号, 文件序号, 贡献像素, 文件名, 路径",
            "",
        ]
        for item in rows:
            stat = result.stat_for(item.original_index) if result else None
            contributed = stat.contributed_pixels if stat else 0
            prefix = "" if include_all or _is_participating(item, start, end) else "[not-participating] "
            lines.append(
                f"{item.original_index}\t{item.display_number()}\t{contributed}\t"
                f"{prefix}{item.file_name}\t{item.path}"
            )
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return target

    with target.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        header = [
            "original_index",
            "source_number",
            "display_number",
            "filename",
            "path",
        ]
        if include_all:
            header.extend(["participating", "in_range", "manually_excluded", "usable"])
        header.extend(
            [
                "flash_detected",
                "candidate_pixels",
                "contributed_pixels",
                "roi_retained_pixels",
                "roi_candidate_pixels",
                "roi_max_excess",
                "note",
            ]
        )
        writer.writerow(header)

        for item in rows:
            in_range = start <= item.original_index <= end
            participating = _is_participating(item, start, end)
            stat = result.stat_for(item.original_index) if result else None
            roi = roi_by_index.get(item.original_index)
            note = item.load_error or ""
            if not note and stat and stat.reason:
                note = stat.reason

            row = [
                item.original_index,
                item.source_number if item.source_number is not None else "",
                item.display_number(),
                item.file_name,
                str(item.path),
            ]
            if include_all:
                row.extend(
                    [
                        int(participating),
                        int(in_range),
                        int(item.excluded),
                        int(item.usable),
                    ]
                )
            row.extend(
                [
                    int(stat.flash_detected) if stat else 0,
                    stat.candidate_pixels if stat else 0,
                    stat.contributed_pixels if stat else 0,
                    roi.retained_pixels if roi else "",
                    roi.candidate_pixels if roi else "",
                    f"{roi.max_excess:.2f}" if roi else "",
                    note,
                ]
            )
            writer.writerow(row)
    return target


def participating_indices(items: Sequence[FrameItem], params: StackParams) -> list[int]:
    end = params.end if params.end is not None else max((i.original_index for i in items), default=params.start)
    return [item.original_index for item in items if _is_participating(item, params.start, end)]
