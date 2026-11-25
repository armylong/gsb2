"""底图与样块的读取、统一裁切、格子划分。

关键约定：
- 样块统一做“居中 cover 裁切”成正方形（格子始终是正方形），
  实际使用的源图区域记录在 ``Tile.crop_box``（原图坐标 left,upper,right,lower），
  并会写进使用记录 CSV/JSON，可追溯每块样块究竟用了哪部分。
- 样块原图可能很大，内存里只保留裁切后的小缩略图与特征；
  导出成品时按 path + crop_box 重新打开原图取高清裁切。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageOps

from .config import IMAGE_SUFFIXES
from .features import Feature, extract_feature

THUMB_SIZE = 192


@dataclass
class Tile:
    ordinal: int                 # 在当前样块列表中的序号（引擎用）
    id: str                      # 稳定唯一 id（相对路径去扩展名）
    name: str                    # 展示名（文件名去扩展名）
    path: str                    # 原图绝对路径
    source_group: str            # 来源分组（相对样块根目录的子目录，根目录文件归根目录名）
    crop_box: tuple[int, int, int, int]  # 实际使用区域，原图坐标
    source_size: tuple[int, int]
    feature: Feature = field(repr=False)
    thumb: Image.Image = field(repr=False, compare=False)
    sha1: str = ""

    def cropped_image(self) -> Image.Image:
        """按 crop_box 从原图重新取裁切图（带 EXIF 方向校正）。"""
        with Image.open(self.path) as im:
            im = ImageOps.exif_transpose(im)
            im = im.convert("RGB")
            return im.crop(self.crop_box)

    def tile_image(self, size: int) -> Image.Image:
        """取一块 size×size 的 RGB 成品图（导出时走原图，尽量清晰）。"""
        crop = self.cropped_image()
        if size and crop.width != size:
            crop = crop.resize((size, size), Image.Resampling.LANCZOS)
        return crop


def file_sha1(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def center_square_crop(size: tuple[int, int]) -> tuple[int, int, int, int]:
    """给定原图尺寸，返回居中正方形裁切框。"""
    w, h = size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return (left, top, left + side, top + side)


def load_image_rgb(path: str | Path) -> Image.Image:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"找不到图片：{p}")
    im = Image.open(p)
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def load_tile(path: Path, ordinal: int, tile_root: Path,
              compute_hash: bool = True) -> Tile:
    """读取单张样块并完成统一正方形裁切、特征提取。"""
    path = path.resolve()
    im = load_image_rgb(path)
    source_size = im.size
    box = center_square_crop(source_size)
    cropped = im.crop(box)

    thumb = cropped.copy()
    thumb.thumbnail((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
    if thumb.size != (THUMB_SIZE, THUMB_SIZE):
        # 样块本身就是正方形裁切，thumbnail 后仍是正方形；极小图补足画布。
        side = max(thumb.size)
        canvas = Image.new("RGB", (side, side), (240, 240, 240))
        canvas.paste(thumb, ((side - thumb.width) // 2,
                             (side - thumb.height) // 2))
        thumb = canvas.resize((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)

    rel = path.relative_to(tile_root.resolve()) if _is_relative_to(path, tile_root.resolve()) else Path(path.name)
    tile_id = rel.with_suffix("").as_posix()
    if len(rel.parts) >= 2:
        group = rel.parts[0]
    else:
        group = tile_root.name or "样块"

    digest = file_sha1(str(path)) if compute_hash else ""
    return Tile(
        ordinal=ordinal,
        id=tile_id,
        name=path.stem,
        path=str(path),
        source_group=group,
        crop_box=box,
        source_size=source_size,
        feature=extract_feature(cropped),
        thumb=thumb,
        sha1=digest[:12],
    )


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def iter_image_files(folder: str | Path) -> list[Path]:
    root = Path(folder)
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"找不到样块文件夹：{root}")
    files = [
        p for p in sorted(root.rglob("*"))
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES
        and not p.name.startswith(".")
    ]
    return files


def load_tiles_from_folder(folder: str | Path,
                           compute_hash: bool = True) -> list[Tile]:
    """递归读取文件夹内全部图片作为样块，子目录名即“来源分组”。"""
    root = Path(folder).resolve()
    files = iter_image_files(root)
    tiles: list[Tile] = []
    used_ids: dict[str, int] = {}
    for i, p in enumerate(files):
        try:
            tile = load_tile(p, i, root, compute_hash=compute_hash)
        except Exception as exc:  # 坏图不应让整个工具崩掉
            print(f"[warn] 跳过无法读取的样块 {p}: {exc}")
            continue
        # 不同子目录可能产生相同 id（理论上相对路径不会），保险去重。
        if tile.id in used_ids:
            used_ids[tile.id] += 1
            tile.id = f"{tile.id}_{used_ids[tile.id]}"
        else:
            used_ids[tile.id] = 1
        tile.ordinal = len(tiles)
        tiles.append(tile)
    return tiles


@dataclass
class Cell:
    index: int
    row: int
    col: int
    source_rect: tuple[int, int, int, int]  # 底图上的实际取图区域
    feature: Feature = field(repr=False)


@dataclass
class GridLayout:
    cols: int
    rows: int
    cell_size: int
    base_size: tuple[int, int]
    used_rect: tuple[int, int, int, int]    # 为整除格子而实际使用的居中区域
    cells: list[Cell]

    @property
    def count(self) -> int:
        return self.cols * self.rows


def build_grid(base: Image.Image, cell_size: int) -> GridLayout:
    """按 cell_size（底图像素）划分格子；边缘除不尽的部分居中裁掉。"""
    w, h = base.size
    if cell_size < 4:
        cell_size = 4
    # 图比请求的格子还小时，把格子缩到较短边，保证裁切框始终在图内。
    cell_size = min(cell_size, max(4, min(w, h)))
    cols = max(1, w // cell_size)
    rows = max(1, h // cell_size)
    # 极端宽/窄图下，floor 出来的总跨度仍可能等于 0?不会，cols>=1 且
    # cell_size<=min(w,h)，故 cols*cell_size<=w、rows*cell_size<=h。
    used_w, used_h = cols * cell_size, rows * cell_size
    left = (w - used_w) // 2
    top = (h - used_h) // 2
    used_rect = (left, top, left + used_w, top + used_h)

    cells: list[Cell] = []
    idx = 0
    for r in range(rows):
        for c in range(cols):
            x0 = left + c * cell_size
            y0 = top + r * cell_size
            rect = (x0, y0, x0 + cell_size, y0 + cell_size)
            patch = base.crop(rect)
            cells.append(Cell(
                index=idx, row=r, col=c, source_rect=rect,
                feature=extract_feature(patch),
            ))
            idx += 1

    return GridLayout(cols=cols, rows=rows, cell_size=cell_size,
                      base_size=(w, h), used_rect=used_rect, cells=cells)
