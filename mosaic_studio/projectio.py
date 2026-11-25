"""方案文件 / 示例 scenario.json 的保存与读取。

方案文件记录：底图与样块目录（优先存相对方案文件的相对路径）、
全部参数、每样块配额覆盖、手动固定格（按行列）、种子。
相同素材 + 该文件即可重现排版。
"""
from __future__ import annotations

import json
from pathlib import Path

from .config import MosaicParams
from .session import MosaicSession

PROJECT_APP = "mosaic-studio-project"
SCENARIO_APP = "mosaic-studio-scenario"


def _rel_or_abs(target: str | None, base_dir: Path) -> str | None:
    if not target:
        return None
    p = Path(target)
    try:
        rel = p.resolve().relative_to(base_dir.resolve())
        return rel.as_posix()
    except (ValueError, OSError):
        return str(p)


def _resolve_path(value: str | None, base_dir: Path) -> Path | None:
    if not value:
        return None
    p = Path(value)
    if not p.is_absolute():
        p = base_dir / p
    return p


def save_project(session: MosaicSession, path: str | Path) -> Path:
    path = Path(path)
    base_dir = path.parent
    grid = session.grid
    data = {
        "app": PROJECT_APP,
        "schema_version": 1,
        "params": session.params.to_dict(),
        "base_image": _rel_or_abs(session.base_path, base_dir),
        "tile_folder": _rel_or_abs(session.tile_folder, base_dir),
        "quota_overrides": session.quota_overrides,
        "fixed": [
            {"row": idx // grid.cols, "col": idx % grid.cols, "tile_id": tid}
            for idx, tid in sorted(session.fixed.items())
        ] if grid else [],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return path


def load_project_file(path: str | Path) -> dict:
    path = Path(path)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if data.get("app") not in (PROJECT_APP, SCENARIO_APP):
        # 宽容：只要像参数文件也接受。
        if "params" not in data:
            raise ValueError("不是有效的马赛克方案文件")
    return data


def apply_project(session: MosaicSession, path: str | Path,
                  *, solve: bool = True) -> MosaicSession:
    """按方案文件重建会话状态。素材缺失时抛 FileNotFoundError。"""
    path = Path(path).resolve()
    data = load_project_file(path)
    base_dir = path.parent

    session.params = MosaicParams.from_dict(data.get("params", {}))
    session.quota_overrides = dict(data.get("quota_overrides", {}))

    base_path = _resolve_path(data.get("base_image"), base_dir)
    tile_folder = _resolve_path(data.get("tile_folder"), base_dir)

    missing: list[str] = []
    if base_path is None or not base_path.exists():
        missing.append(f"底图：{base_path}")
    if tile_folder is None or not tile_folder.exists():
        missing.append(f"样块文件夹：{tile_folder}")
    if missing:
        raise FileNotFoundError("；".join(missing))

    session.load_base(base_path)
    session.load_tile_folder(tile_folder)

    fixed: dict[int, str] = {}
    cols = session.grid.cols  # type: ignore[union-attr]
    rows = session.grid.rows  # type: ignore[union-attr]
    for item in data.get("fixed", []):
        tid = item.get("tile_id")
        r, c = int(item["row"]), int(item["col"])
        if tid in session.tile_by_id and 0 <= r < rows and 0 <= c < cols:
            fixed[r * cols + c] = tid
    session.fixed = fixed

    if solve:
        session.solve()
    return session
