"""导出成品配套的格子使用记录（CSV）与完整报告（JSON）。"""
from __future__ import annotations

import csv
import json
from pathlib import Path

from .config import UNLIMITED
from .features import similarity
from .session import MosaicSession

CELL_HEADER = [
    "行", "列", "状态", "是否固定", "样块ID", "样块名", "来源分组",
    "源文件路径", "裁切左", "裁切上", "裁切右", "裁切下",
    "相似度", "距离代价", "未匹配原因代码", "未匹配原因",
    "最相似样块ID", "最相似相似度",
]

TILE_HEADER = [
    "样块ID", "样块名", "来源分组", "源文件路径", "sha1短码",
    "原图宽", "原图高", "裁切框", "配额", "总使用次数", "其中固定次数",
]


def _status_cn(status: str) -> str:
    return {"fixed": "固定", "matched": "已匹配",
            "unmatched": "未匹配"}.get(status, status)


def write_cell_csv(session: MosaicSession, path: str | Path) -> Path:
    if session.result is None or session.grid is None:
        raise RuntimeError("还没有计算结果，无法导出使用记录")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    res = session.result

    # 每块样块的最终用量/配额按序号取。
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(CELL_HEADER)
        for o in res.outcomes:
            tile = session.tiles[o.tile] if o.tile is not None else None
            best = session.tiles[o.best_tile] if o.best_tile is not None else None
            writer.writerow([
                o.row + 1, o.col + 1,
                _status_cn(o.status), "是" if o.fixed else "否",
                tile.id if tile else "",
                tile.name if tile else "",
                tile.source_group if tile else "",
                tile.path if tile else "",
                *(tile.crop_box if tile else ("", "", "", "")),
                f"{similarity(o.cost):.4f}" if o.cost is not None else "",
                f"{o.cost:.4f}" if o.cost is not None else "",
                o.reason_code or "",
                o.reason or "",
                best.id if best else "",
                f"{similarity(o.best_cost):.4f}" if o.best_cost is not None else "",
            ])
    return path


def write_tile_csv(session: MosaicSession, path: str | Path) -> Path:
    if session.result is None:
        raise RuntimeError("还没有计算结果")
    path = Path(path)
    res = session.result
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(TILE_HEADER)
        for j, t in enumerate(session.tiles):
            q = res.quota[j]
            writer.writerow([
                t.id, t.name, t.source_group, t.path, t.sha1,
                t.source_size[0], t.source_size[1],
                ",".join(str(v) for v in t.crop_box),
                "不限" if q == UNLIMITED else q,
                res.usage[j], res.fixed_usage[j],
            ])
    return path


def build_report_dict(session: MosaicSession) -> dict:
    if session.result is None or session.grid is None:
        raise RuntimeError("还没有计算结果")
    res = session.result
    g = session.grid

    cells = []
    for o in res.outcomes:
        tile = session.tiles[o.tile] if o.tile is not None else None
        cells.append({
            "row": o.row, "col": o.col,
            "row_human": o.row + 1, "col_human": o.col + 1,
            "status": o.status, "fixed": o.fixed,
            "tile_id": tile.id if tile else None,
            "tile_name": tile.name if tile else None,
            "source_group": tile.source_group if tile else None,
            "crop_box": list(tile.crop_box) if tile else None,
            "distance": round(o.cost, 6) if o.cost is not None else None,
            "similarity": round(similarity(o.cost), 6) if o.cost is not None else None,
            "reason_code": o.reason_code,
            "reason": o.reason,
            "quota_blocker_ids": [session.tiles[j].id for j in o.quota_blockers],
            "adjacency_blocker_ids": [session.tiles[j].id for j in o.adjacency_blockers],
        })

    tiles = [{
        "ordinal": t.ordinal, "id": t.id, "name": t.name,
        "source_group": t.source_group, "path": t.path, "sha1": t.sha1,
        "source_size": list(t.source_size), "crop_box": list(t.crop_box),
        "quota": None if res.quota[j] == UNLIMITED else res.quota[j],
        "usage": res.usage[j], "fixed_usage": res.fixed_usage[j],
    } for j, t in enumerate(session.tiles)]

    return {
        "app": "mosaic-studio-report",
        "schema_version": 1,
        "seed": session.params.seed,
        "reproducibility_note": (
            "保留本文件中的 seed、params、素材路径、sha1 与 crop_box，"
            "用相同素材重新载入并计算即可重现一致排版；fixed 为手动固定格。"
        ),
        "params": session.params.to_dict(),
        "base_image": {
            "path": session.base_path,
            "size": list(session.base_image.size) if session.base_image else None,
            "grid_cols": g.cols, "grid_rows": g.rows,
            "cell_size": g.cell_size, "used_rect": list(g.used_rect),
        },
        "tile_folder": session.tile_folder,
        "quota_overrides": session.quota_overrides,
        "fixed": [
            {"row": idx // g.cols, "col": idx % g.cols, "tile_id": tid}
            for idx, tid in sorted(session.fixed.items())
        ],
        "summary": {
            "cell_count": res.cell_count,
            "tile_count": res.tile_count,
            "assigned_count": res.assigned_count,
            "unmatched_count": res.unmatched_count,
            "free_deficit": res.free_deficit,
            "capacity_total": res.capacity_total,
            "free_capacity": res.free_capacity,
            "elapsed_ms": res.elapsed_ms,
            "fixed_conflicts": [
                {"kind": fc.kind,
                 "tile_id": session.tiles[fc.tile].id,
                 "cells": [{"row": c // g.cols, "col": c % g.cols}
                           for c in fc.cells],
                 "detail": fc.detail}
                for fc in res.fixed_conflicts
            ],
        },
        "tiles": tiles,
        "cells": cells,
    }


def write_report_json(session: MosaicSession, path: str | Path) -> Path:
    path = Path(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(build_report_dict(session), f, ensure_ascii=False, indent=2)
    return path


def export_records(session: MosaicSession, image_path: str | Path) -> dict[str, Path]:
    """根据成品图片路径写出同名的格子记录 / 样块用量 / JSON 报告。"""
    image_path = Path(image_path)
    stem = image_path.with_suffix("")
    paths = {
        "cells_csv": stem.with_name(stem.name + "_格子记录.csv"),
        "tiles_csv": stem.with_name(stem.name + "_样块用量.csv"),
        "json": stem.with_name(stem.name + "_报告.json"),
    }
    write_cell_csv(session, paths["cells_csv"])
    write_tile_csv(session, paths["tiles_csv"])
    write_report_json(session, paths["json"])
    return paths
