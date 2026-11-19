"""导出与标签回读的精确测试。"""
from __future__ import annotations

import csv

import numpy as np

from ccstats.demos import get_demo
from ccstats.export import (
    CSV_FIELDS, export_all, read_label_png, render_inspection, write_label_png,
)
from ccstats.imageio import fit_long_edge, load_image
from ccstats.models import (
    Connectivity, FilterCriteria, FilterReason, Polarity, SegmentParams, ThresholdParams,
)
from ccstats.segment import reevaluate, segment


def _result(demo_key="circular", conn=Connectivity.EIGHT, criteria=None, manual=None):
    demo = get_demo(demo_key)
    params = SegmentParams(
        threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
        connectivity=conn,
    )
    return segment(demo.image, params, criteria or FilterCriteria(), manual or set())


def _bgr(result):
    demo = get_demo("circular")
    import cv2
    return cv2.cvtColor(demo.image, cv2.COLOR_GRAY2BGR)


def test_label_png_roundtrip_keeps_exact_ids_and_background_zero(tmp_path):
    r = _result()
    p = write_label_png(r, tmp_path / "labels.png")
    back = read_label_png(p)
    assert back.dtype == np.int32
    assert np.array_equal(back, r.labels.astype(np.int32))
    # 背景恰好为 0，非零编号与表格编号完全一致
    assert set(np.unique(back).tolist()) == {0, 1, 2, 3, 4}
    ids_in_table = [rec.stats.label_id for rec in r.regions]
    assert sorted(ids_in_table) == [1, 2, 3, 4]
    for rec in r.regions:
        assert int((back == rec.stats.label_id).sum()) == rec.stats.area


def test_export_keeps_filtered_regions_in_label_image(tmp_path):
    r = _result()
    # 全部 4 个区域经由面积上限筛成 2 个
    reevaluate(r, FilterCriteria(max_area=1000))
    assert r.included_count == 2
    paths = export_all(r, _bgr(r), tmp_path, "filtered", {"path": "demo"})
    back = read_label_png(paths["label_png"])
    # 被筛掉的两个区域仍在标签图里，编号不重排
    assert set(np.unique(back).tolist()) == {0, 1, 2, 3, 4}
    assert int((back == 1).sum()) == r.regions[0].stats.area
    assert int((back == 4).sum()) == r.regions[3].stats.area


def test_csv_contains_all_regions_with_included_flag_and_reason(tmp_path):
    r = _result()
    reevaluate(r, FilterCriteria(min_area=2000, exclude_border=False), manual_ignored={2})
    paths = export_all(r, _bgr(r), tmp_path, "csvcheck", {"path": "demo"})
    with open(paths["csv"], encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    data = [row for row in rows if row["编号"] and not row["编号"].startswith("#")]
    assert len(data) == r.total_count == 4
    by_id = {int(row["编号"]): row for row in data}
    assert by_id[1]["是否计入"] == "否"
    assert by_id[1]["排除原因"] == FilterReason.SMALL.text
    assert int(by_id[1]["面积(px)"]) == 1257
    assert by_id[2]["排除原因"] == FilterReason.MANUAL.text
    assert by_id[3]["排除原因"] == FilterReason.SMALL.text
    assert by_id[4]["是否计入"] == "是"
    assert int(by_id[4]["孔洞数"]) == 2
    # 汇总行只累计当前计入的实际区域面积
    summary = {row["编号"]: row["面积(px)"] for row in rows if row["编号"].startswith("#")}
    assert int(summary["# 全部区域数"]) == 4
    assert int(summary["# 计入区域数"]) == 1
    assert int(summary["# 计入总面积(px)"]) == 8966


def test_csv_header_and_all_regions_when_nothing_filtered(tmp_path):
    r = _result("diagonal")
    paths = export_all(r, _bgr(r), tmp_path, "plain")
    with open(paths["csv"], encoding="utf-8-sig") as f:
        header = f.readline().strip().split(",")
    assert header == CSV_FIELDS
    with open(paths["csv"], encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    assert all(row["是否计入"] == "是" for row in rows if row["编号"] and not row["编号"].startswith("#"))
    assert len([r for r in rows if r["编号"] and not r["编号"].startswith("#")]) == r.total_count


def test_inspection_png_is_original_size_and_all_regions_labelled(tmp_path):
    r = _result()
    reevaluate(r, FilterCriteria(max_area=1000))
    paths = export_all(r, _bgr(r), tmp_path, "inspect")
    import cv2
    png = cv2.imread(str(paths["inspection"]), cv2.IMREAD_COLOR)
    assert png is not None
    assert png.shape[:2] == r.labels.shape
    # 被筛掉的区域用红色轮廓画出；这里只验证渲染不崩且尺寸正确
    assert render_inspection(r, _bgr(r)).shape[:2] == r.labels.shape


def test_empty_label_export(tmp_path):
    r = _result("empty")
    assert r.total_count == 0
    paths = export_all(r, _bgr(r), tmp_path, "empty")
    back = read_label_png(paths["label_png"])
    assert back.shape == r.labels.shape
    assert not back.any()


def test_reread_labels_match_after_second_run(tmp_path):
    r1 = _result()
    r2 = _result()
    assert np.array_equal(r1.labels, r2.labels)
    b1 = read_label_png(write_label_png(r1, tmp_path / "a.png"))
    b2 = read_label_png(write_label_png(r2, tmp_path / "b.png"))
    assert np.array_equal(b1, b2)


def test_load_image_keeps_original_resolution(tmp_path):
    import cv2
    # 长边 2000：保持原尺寸处理，坐标/面积/导出都对应文件本身
    img = np.zeros((1000, 2000), np.uint8)
    img[100:200, 100:300] = 255
    path = tmp_path / "big.png"
    assert cv2.imwrite(str(path), img)
    out, gray, info = load_image(str(path))
    assert gray.shape == (1000, 2000)
    assert not info["resized"]
    assert info["original_size"] == (2000, 1000)
    assert info["size"] == (2000, 1000)
    assert info["over_limit"]
    # 小图同样原样保留
    small = np.zeros((50, 80), np.uint8)
    p2 = tmp_path / "small.png"
    assert cv2.imwrite(str(p2), small)
    out2, gray2, info2 = load_image(str(p2))
    assert gray2.shape == (50, 80)
    assert not info2["over_limit"]
    # 彩色图读取为灰度，原图仍为彩色
    color = np.zeros((30, 40, 3), np.uint8)
    color[:, :, 1] = 255
    p3 = tmp_path / "c.jpg"
    assert cv2.imwrite(str(p3), color)
    img3, gray3, info3 = load_image(str(p3))
    assert gray3.ndim == 2 and img3.ndim == 3 and info3["color"]


def test_fit_long_edge_identity_for_small_image():
    img = np.arange(60, dtype=np.uint8).reshape(6, 10)
    same = fit_long_edge(img, 1600)
    assert same.shape == img.shape
    assert np.array_equal(same, img)
