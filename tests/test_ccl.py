"""连通区域标记测试：同色不接触必须各自独立，细桥必须保持同一块。"""

import unittest

import numpy as np
from PIL import Image

from colorbook.ccl import label_connected, to_rgb_array


def _image_from_grid(grid, palette):
    h = len(grid)
    w = len(grid[0])
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    for y, row in enumerate(grid):
        for x, idx in enumerate(row):
            arr[y, x] = palette[idx]
    return Image.fromarray(arr, mode="RGB")


class TestCCL(unittest.TestCase):
    def test_disconnected_same_color_gets_separate_labels(self):
        # 两块红色被白色隔开，必须得到不同标签
        palette = [(255, 255, 255), (220, 0, 0)]
        grid = [
            [0, 0, 0, 0, 0],
            [0, 1, 0, 1, 0],
            [0, 1, 0, 1, 0],
            [0, 0, 0, 0, 0],
        ]
        result = label_connected(to_rgb_array(_image_from_grid(grid, palette)))
        labels = result["labels"]
        self.assertNotEqual(labels[1, 1], labels[1, 3])
        self.assertEqual(len(result["areas"]), 3)
        # 两块红色面积相同
        red_areas = sorted(
            int(a)
            for a, color in zip(result["areas"], result["colors"])
            if tuple(color) == (220, 0, 0)
        )
        self.assertEqual(red_areas, [2, 2])

    def test_thin_bridge_keeps_one_region(self):
        # 两个大块通过一条 1px 细桥相连，4 连通下必须是同一个区域
        palette = [(255, 255, 255), (0, 0, 220)]
        grid = [
            [1, 1, 0, 1, 1],
            [1, 1, 1, 1, 1],  # 中间一行整行连通（细桥）
            [1, 1, 0, 1, 1],
            [0, 0, 0, 0, 0],
        ]
        result = label_connected(to_rgb_array(_image_from_grid(grid, palette)))
        labels = result["labels"]
        self.assertEqual(labels[0, 0], labels[0, 4])
        blue = [
            i
            for i, color in enumerate(result["colors"])
            if tuple(color) == (0, 0, 220)
        ]
        self.assertEqual(len(blue), 1)
        # 面积 = 13 个蓝像素（两行各 5 个 + 中间桥行 3 个）
        self.assertEqual(int(result["areas"][blue[0]]), 13)

    def test_diagonal_touch_is_not_connected(self):
        # 只有对角接触时 4 连通不算连通（两个绿块 + 两块白背景）
        palette = [(255, 255, 255), (0, 200, 0)]
        grid = [
            [1, 0],
            [0, 1],
        ]
        result = label_connected(to_rgb_array(_image_from_grid(grid, palette)))
        self.assertEqual(len(result["areas"]), 4)
        self.assertNotEqual(result["labels"][0, 0], result["labels"][1, 1])

    def test_areas_and_bboxes(self):
        palette = [(255, 255, 255), (0, 0, 0)]
        grid = [
            [0, 0, 0, 0],
            [0, 1, 1, 0],
            [0, 1, 1, 0],
            [0, 0, 0, 0],
        ]
        result = label_connected(to_rgb_array(_image_from_grid(grid, palette)))
        black = [
            i
            for i, color in enumerate(result["colors"])
            if tuple(color) == (0, 0, 0)
        ][0]
        self.assertEqual(int(result["areas"][black]), 4)
        self.assertEqual(tuple(int(v) for v in result["bboxes"][black]), (1, 1, 2, 2))

    def test_single_color_image(self):
        img = Image.new("RGB", (10, 8), (10, 20, 30))
        result = label_connected(to_rgb_array(img))
        self.assertEqual(len(result["areas"]), 1)
        self.assertEqual(int(result["areas"][0]), 80)
        self.assertTrue((result["labels"] == 0).all())


if __name__ == "__main__":
    unittest.main()
