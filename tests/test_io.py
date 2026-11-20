"""导出/导入验证：实际尺寸落盘、对应记录表达已删像素、不可行结果如实标注。"""

import json

import cv2
import numpy as np

from content_aware import demos
from content_aware.engine import carve_width
from content_aware.io import export_result, load_image, ImageLoadError


def test_export_roundtrip_records_deleted_pixels(tmp_path, scene):
    image = scene["image"]
    h, w = image.shape[:2]
    target = int(w * 0.8)
    out = carve_width(image, np.zeros((h, w), bool), target)

    paths = export_result(out, tmp_path / "res")
    written = cv2.imread(str(paths["png"]))
    assert written.shape == (h, target, 3)

    data = np.load(paths["map"])
    assert data["result_width"] == target and data["result_height"] == h
    assert data["source_width"] == w
    # source_status 中删除标记数量 == 实际删除像素数
    assert int(data["source_status"].sum()) == len(out.removed_source_points)
    assert data["removed_points"].shape == (len(out.removed_source_points), 2)
    # result_to_source 与引擎输出一致
    assert np.array_equal(data["result_to_source"], out.source_index)

    meta = json.loads(paths["meta"].read_text(encoding="utf-8"))
    assert meta["actual_width"] == target and meta["completed"] is True
    assert meta["removed_pixel_count"] == (w - target) * h


def test_infeasible_export_reports_true_size_not_target(tmp_path, scene):
    image = scene["image"]
    h, w = image.shape[:2]
    mask = demos.make_blocked_mask(h, w)
    out = carve_width(image, mask, int(w * 0.8))
    paths = export_result(out, tmp_path / "blocked")
    meta = json.loads(paths["meta"].read_text(encoding="utf-8"))

    assert meta["actual_width"] == w                      # 不能标成目标尺寸
    assert meta["target_width"] == int(w * 0.8)
    assert meta["completed"] is False
    assert meta["stopped_infeasible"] is True
    assert meta["remaining_to_target"] > 0


def test_load_image_rejects_transparent_and_wrong_size(tmp_path):
    # 透明 PNG 必须被拒
    rgba = np.zeros((240, 300, 4), dtype=np.uint8)
    rgba[:, :, :3] = 100
    rgba[:, :, 3] = 128
    p = tmp_path / "alpha.png"
    cv2.imwrite(str(p), rgba)
    try:
        load_image(p)
        assert False, "透明图应被拒绝"
    except ImageLoadError:
        pass

    # 尺寸越界必须被拒
    small = np.zeros((100, 300, 3), dtype=np.uint8)
    p2 = tmp_path / "small.jpg"
    cv2.imwrite(str(p2), small)
    try:
        load_image(p2)
        assert False, "小于 200px 的图应被拒绝"
    except ImageLoadError:
        pass


def test_load_opaque_image_roundtrip(tmp_path, scene):
    p = tmp_path / "ok.png"
    cv2.imwrite(str(p), scene["image"])
    loaded = load_image(p)
    assert loaded.shape == scene["image"].shape
    assert loaded.dtype == np.uint8
