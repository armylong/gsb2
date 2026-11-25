"""程序入口。

用法:
  python -m panel_splitter.main                 启动窗口
  python -m panel_splitter.main --demo out.png  只生成演示图, 不启动 GUI
  python -m panel_splitter.main --headless out  无头跑完整流程并导出到 out/
"""

from __future__ import annotations

import os
import sys

from .demo_image import generate_demo_page
from .exporting import export_panels
from .model import PageModel
from .ordering import compute_order
from .segmentation import segment_image


def _headless_demo(out_dir: str) -> None:
    import cv2

    img = generate_demo_page(os.path.join(out_dir, "demo_page.png"))
    os.makedirs(out_dir, exist_ok=True)
    seg = segment_image(img)
    print(f"初次切分: {len(seg.panels)} 格, 断缝提示 {len(seg.partial_cuts)} 条")

    model = PageModel(img.shape, seg.panels)
    # 人工补断缝: 直接按检测到的局部缝位置补刀
    for cut in seg.partial_cuts:
        model.apply_partial_cut(cut)
    # 合并底行被假缝误切的两块
    bottom = [i for i, p in enumerate(model.panels) if p[1] >= img.shape[0] * 0.7]
    if len(bottom) >= 2:
        model.merge_panels(bottom)

    info = compute_order(model.panels, "ltr")
    items, manifest, review = export_panels(
        img, model.panels, info, out_dir, margin_px=6
    )
    print(f"导出 {len(items)} 张小图 -> {out_dir}")
    print("清单:", manifest)
    print("回查图:", review)
    cv2.imwrite(os.path.join(out_dir, "review.png"),
                cv2.imread(review))


def main() -> int:
    if "--demo" in sys.argv:
        out = sys.argv[sys.argv.index("--demo") + 1]
        generate_demo_page(out)
        print("演示图已生成:", out)
        return 0
    if "--headless" in sys.argv:
        out = sys.argv[sys.argv.index("--headless") + 1]
        _headless_demo(out)
        return 0

    from PySide6.QtWidgets import QApplication
    from .gui.main_window import MainWindow

    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
