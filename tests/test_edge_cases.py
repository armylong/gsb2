"""切分与顺序的边界情况测试。"""

from __future__ import annotations

import numpy as np

from panel_splitter.model import PageModel
from panel_splitter.ordering import compute_order
from panel_splitter.segmentation import segment_image


def test_uniform_page_is_single_panel():
    blank = np.full((500, 400, 3), 240, np.uint8)
    result = segment_image(blank)
    assert len(result.panels) == 1
    assert result.panels[0] == (0, 0, 400, 500)


def test_white_page_is_single_panel():
    white = np.full((500, 400, 3), 255, np.uint8)
    result = segment_image(white)
    # 整页都是背景, 没有任何内容格, 应只返回整页一个矩形
    assert len(result.panels) == 1


def test_two_vertical_panels_direction():
    img = np.full((400, 600, 3), 255, np.uint8)
    img[:, :280] = (180, 180, 180)
    img[:, 320:] = (160, 160, 160)
    result = segment_image(img)
    assert len(result.panels) == 2
    model = PageModel(img.shape, result.panels)
    assert compute_order(model.panels, "ltr").order == [0, 1]
    assert compute_order(model.panels, "rtl").order == [1, 0]


def test_empty_order():
    info = compute_order([], "ltr")
    assert info.order == []
    assert info.bands == []
    assert info.spanning == set()


def test_t_layout_spanning_panel():
    """构造 T 形接版: 左格跨两行, 右侧上下两格。"""
    img = np.full((600, 500, 3), 255, np.uint8)
    # 左格 (深色) 占满高度
    img[20:580, 20:220] = (170, 170, 170)
    # 右上 / 右下
    img[20:280, 240:480] = (150, 150, 150)
    img[320:580, 240:480] = (130, 130, 130)
    result = segment_image(img)
    assert len(result.panels) == 3
    info = compute_order(result.panels, "ltr")
    # 左格应被判跨行
    left = next(i for i, p in enumerate(result.panels) if p[0] < 220)
    assert left in info.spanning
    # 跨行格归属顶部带, 且只出现一次
    assert info.order.count(left) == 1
    # LTR: 左格在它的带里排最前
    band1 = dict(info.bands)[info.owner_band[left]]
    assert band1[0] == left


def main():
    test_uniform_page_is_single_panel()
    test_white_page_is_single_panel()
    test_two_vertical_panels_direction()
    test_empty_order()
    test_t_layout_spanning_panel()
    print("边界情况测试全部通过 ✔")


if __name__ == "__main__":
    main()
