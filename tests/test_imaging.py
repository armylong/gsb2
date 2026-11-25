from pathlib import Path

from PIL import Image

from mosaic_studio.imaging import build_grid, center_square_crop, load_tile


def test_center_square_crop_records_actual_region():
    # 200x100 的横图 -> 100x100 居中，左右各裁掉 50。
    box = center_square_crop((200, 100))
    assert box == (50, 0, 150, 100)
    cropped_size = (box[2] - box[0], box[3] - box[1])
    assert cropped_size == (100, 100)


def test_load_tile_uses_recorded_crop_box(tmp_path: Path):
    p = tmp_path / "wide.jpg"
    Image.new("RGB", (240, 120), (10, 120, 200)).save(p)
    tile = load_tile(p, 0, tmp_path)
    assert tile.crop_box == (60, 0, 180, 120)
    assert tile.source_size == (240, 120)
    # 按记录的 crop_box 重新取图，尺寸必须与实际使用范围一致。
    crop = tile.cropped_image()
    assert crop.size == (120, 120)


def test_build_grid_covers_centered_exact_cells():
    base = Image.new("RGB", (905, 1207), (30, 30, 30))
    g = build_grid(base, 40)
    assert g.cols == 22 and g.rows == 30
    assert g.count == 660
    assert g.used_rect == (12, 3, 892, 1203)
    first = g.cells[0].source_rect
    assert first == (12, 3, 52, 43)
