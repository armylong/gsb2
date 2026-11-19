"""端到端流程测试: 样例生成、格点往返误差、标注随选区变化、导出。

数值期望来自样例中独立已知的格点坐标, 而非被测代码的二次推算。
"""
import json

import cv2
import numpy as np
import pytest

from rectifier import exporter, geometry as geo, sample_gen


@pytest.fixture(scope="module")
def sample(tmp_path_factory):
    d = tmp_path_factory.mktemp("sample")
    paths = sample_gen.ensure_sample(d)
    meta = json.loads(paths["meta"].read_text(encoding="utf-8"))
    photo = cv2.imread(str(paths["photo"]))
    corners = [meta["corners"][n] for n in geo.CORNER_NAMES]
    return paths, meta, photo, corners


def test_sample_deterministic(tmp_path):
    """样例可恢复: 两次生成的文件字节一致。"""
    p1 = sample_gen.ensure_sample(tmp_path / "a")
    p2 = sample_gen.ensure_sample(tmp_path / "b")
    for key in ("label", "photo", "meta"):
        assert p1[key].read_bytes() == p2[key].read_bytes()


def test_grid_roundtrip_error(sample):
    """照片四角 -> 校正 -> 已知格点坐标, 往返误差 < 0.5 像素。

    期望坐标直接来自 sample_gen.grid_points() 的独立定义。
    """
    _, meta, photo, corners = sample
    W, H = meta["label_size"]
    Hm = geo.homography(corners, W, H)
    grid = np.array(meta["grid_points"])  # 独立已知格点 (标签坐标系)

    # 校正图坐标应复现标签坐标
    rectified = geo.warp(photo, corners, W, H)
    assert rectified.shape == (H, W, 3)

    # 坐标层面: 标签格点 -> 照片 -> 校正, 应回到原格点
    H_label_to_photo = geo.perspective_transform(geo.dst_rect(W, H), np.array(corners))
    photo_pts = geo.map_points(H_label_to_photo, grid)
    back = geo.map_points(Hm, photo_pts)
    err = np.linalg.norm(back - grid, axis=1)
    assert err.max() < 1e-6

    # 图像层面: 校正图在格点处应为深色圆点 (独立验证映射确实落在格点上)
    for x, y in grid:
        px = rectified[int(round(y)), int(round(x))]
        assert px.mean() < 80, f"格点 ({x},{y}) 处不是深色点: {px}"


def test_annotation_reanchor_on_resize(sample):
    """改输出尺寸后标注锚定同一源图位置, 结果侧坐标按比例重定位。"""
    _, meta, _, corners = sample
    W, H = meta["label_size"]
    src_pt = [400.0, 300.0]
    H1 = geo.homography(corners, W, H)
    dst1 = geo.map_points(H1, [src_pt])[0]

    W2, H2 = W // 2, H // 2
    H2m = geo.homography(corners, W2, H2)
    dst2 = geo.map_points(H2m, [src_pt])[0]

    # 同一源点 (源坐标不变), 输出坐标随尺寸线性缩放 (像素中心原点约定下的精确关系)
    assert dst2[0] == pytest.approx(dst1[0] * (W2 - 1) / (W - 1), abs=1e-6)
    assert dst2[1] == pytest.approx(dst1[1] * (H2 - 1) / (H - 1), abs=1e-6)


def test_annotation_out_of_region_on_shrink(sample):
    """选区缩小后, 原标注点被判定为区外。"""
    _, meta, _, corners = sample
    # 选区内一点
    inner = geo.map_points(
        geo.perspective_transform(geo.dst_rect(*meta["label_size"]), np.array(corners)),
        [(320.0, 210.0)],
    )[0]
    assert geo.inside_quad(corners, inner)
    # 缩小选区为上半部分
    shrunk = [
        corners[0],
        corners[1],
        [(corners[1][0] + corners[2][0]) / 2, (corners[1][1] + corners[2][1]) / 2],
        [(corners[0][0] + corners[3][0]) / 2, (corners[0][1] + corners[3][1]) / 2],
    ]
    # 靠近底部的点在新选区外
    low = geo.map_points(
        geo.perspective_transform(geo.dst_rect(*meta["label_size"]), np.array(corners)),
        [(320.0, 400.0)],
    )[0]
    assert geo.inside_quad(corners, low)
    assert not geo.inside_quad(shrunk, low)


def test_export_files(sample, tmp_path):
    """导出三件套: 尺寸精确、JSON 字段齐全、区外点不进检查图。"""
    _, meta, photo, corners = sample
    W, H = meta["label_size"]
    warped = geo.warp(photo, corners, W, H)
    Hm = geo.homography(corners, W, H)

    grid = meta["grid_points"]
    # 区内点: 用前 3 个已知格点 (标签坐标 -> 照片坐标)
    H_label_to_photo = geo.perspective_transform(geo.dst_rect(W, H), np.array(corners))
    src_pts = geo.map_points(H_label_to_photo, grid[:3])
    records = []
    for i, sp in enumerate(src_pts, start=1):
        uv = geo.map_points(Hm, [sp])[0]
        records.append(
            {"id": i, "source": list(sp), "rectified": list(uv), "in_region": True}
        )
    # 区外点: 源图角落, 不在四边形内
    records.append(
        {"id": 4, "source": [5.0, 5.0], "rectified": [-50.0, -50.0], "in_region": False}
    )

    out = tmp_path / "export"
    paths = exporter.export_all(out, warped, records, corners, (W, H), "sample_photo.png")

    rect = cv2.imread(str(paths["rectified"]))
    assert rect.shape == (H, W, 3)  # 不多一行一列

    payload = json.loads(paths["json"].read_text(encoding="utf-8"))
    assert payload["output"] == {"width": W, "height": H}
    assert set(payload["corners"]) == {"TL", "TR", "BR", "BL"}
    assert payload["corners"]["TL"] == [round(c, 3) for c in corners[0]]
    assert len(payload["points"]) == 4
    p1 = payload["points"][0]
    # 第一个格点应回到其已知标签坐标
    assert p1["rectified"][0] == pytest.approx(grid[0][0], abs=1e-3)
    assert p1["rectified"][1] == pytest.approx(grid[0][1], abs=1e-3)
    assert payload["points"][3]["in_region"] is False

    # 检查图: 与校正图不同的像素只能来自区内 3 个点的绘制
    check = cv2.imread(str(paths["check"]))
    diff = np.any(check != rect, axis=-1)
    ys, xs = np.nonzero(diff)
    assert len(xs) > 0
    for x, y in zip(xs, ys):
        assert any(
            abs(x - g[0]) <= 30 and abs(y - g[1]) <= 30 for g in grid[:3]
        ), f"检查图在 ({x},{y}) 出现意外绘制 (可能画入了区外点)"
