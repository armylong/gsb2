"""内置测试图：一张限色 PNG，专门覆盖合并与标签落位的各种边界情况。

包含:
  - 带内孔的环形区域（孔是另一个颜色的区域）
  - 仅靠一条细桥相连的两块同色区域（必须保持同一个区域）
  - 与桥接块同色但完全不接触的孤岛（必须是独立区域、独立可选）
  - 面积很小的碎块（自动合并的目标，可手动保护成"岛"）
  - 面积不小但极窄的狭长带（标签放不下，需要外部引线）
所有边缘均为硬边、无抗锯齿，颜色总数固定。
"""

from __future__ import annotations

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 640, 520

WHITE = (255, 255, 255)
BLUE = (70, 130, 220)
RED = (220, 70, 70)
YELLOW = (240, 210, 70)
GREEN = (90, 180, 90)
PURPLE = (160, 90, 200)

PALETTE = [WHITE, BLUE, RED, YELLOW, GREEN, PURPLE]


def build_sample_image() -> Image.Image:
    """生成内置测试图（RGB，无抗锯齿）。"""
    img = Image.new("RGB", (WIDTH, HEIGHT), WHITE)
    draw = ImageDraw.Draw(img)

    # 1) 蓝色圆环：外框实心矩形 + 内部挖一个黄色内孔
    draw.rectangle([40, 40, 260, 260], fill=BLUE)
    draw.rectangle([110, 110, 190, 190], fill=YELLOW)

    # 2) 两个红色大块，中间只留一条 6px 细桥 -> 必须是同一个区域
    draw.rectangle([330, 60, 450, 180], fill=RED)   # 左上块
    draw.rectangle([520, 60, 620, 180], fill=RED)   # 右上块
    draw.rectangle([450, 117, 520, 123], fill=RED)  # 细桥

    # 3) 与上面同色但不接触的红色孤岛 -> 独立区域
    draw.rectangle([360, 240, 420, 300], fill=RED)

    # 4) 很小的绿色碎块：默认会被面积阈值合并，可手动保护
    draw.rectangle([60, 330, 95, 365], fill=GREEN)  # 36x36 = 1296 像素
    # 再给一个更小的同色不接触碎块，验证同色断块各自独立
    draw.rectangle([130, 400, 148, 418], fill=GREEN)  # 18x18 = 324 像素

    # 5) 紫色狭长带：面积不小但宽度只有 10px，内部放不下数字 -> 外部引线
    draw.rectangle([220, 330, 600, 340], fill=PURPLE)

    # 6) 蓝色小碎片：与圆环同色但不接触，验证同色编号一致、区域独立
    draw.rectangle([560, 420, 590, 450], fill=BLUE)

    # 健全性检查：只允许调色板里的颜色
    colors = img.getcolors(maxcolors=1 << 20)
    used = {c for _, c in colors}
    assert used <= set(PALETTE), f"测试图出现调色板外的颜色: {used}"
    return img


def sample_palette() -> list[tuple[int, int, int]]:
    return list(PALETTE)
