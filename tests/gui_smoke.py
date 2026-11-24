"""离屏 GUI 冒烟测试: 不显示窗口, 走一遍 打开->画点->重算->联动->导出->格纸 流程。"""
import os
import tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
import cv2
from PySide6.QtWidgets import QApplication

from pageflattener.app import MainWindow
from tests.selftest import make_curved_page


def main():
    app = QApplication([])
    win = MainWindow()

    img, line_ys, bend = make_curved_page()
    with tempfile.TemporaryDirectory() as td:
        img_path = os.path.join(td, "page.png")
        cv2.imwrite(img_path, img)

        # 模拟打开图片
        win.img = img
        win.img_path = img_path
        win.src_view.set_image(img)

        # 模拟点 4 个页角
        H, W = img.shape[:2]
        for pt in [(0, 0), (W - 1, 0), (W - 1, H - 1), (0, H - 1)]:
            win.quad.append(pt)
        win.on_quad_maybe_complete()

        # 模拟画 3 条引导曲线
        for gi in (0, 4, 8):
            y0 = line_ys[gi]
            win.curves.append([(float(x), float(y0 + bend(x, y0)))
                               for x in range(60, W - 40, 160)])
        win.active_curve = 0
        win.recompute()
        assert win.flat_img is not None, "展平结果为空"
        assert win.field.n_curves == 3
        print("重算 ok, 输出:", win.flat_img.shape, "曲线:", win.field.n_curves)

        # 联动: 输出 -> 源
        win.on_out_hover(500.0, 400.0)
        assert win.src_view.crosshair is not None
        win.on_src_hover(600.0, 450.0)
        assert win.out_view.crosshair is not None
        print("联动 ok")

        # 点排序调整
        win.selected_point = 1
        before = list(win.curves[0])
        win.move_point(1)
        assert win.curves[0][1] == before[2]
        print("点排序 ok")

        # 导出
        out_png = os.path.join(td, "flat.png")
        cv2.imencode(".png", win.flat_img)[1].tofile(out_png)
        assert os.path.getsize(out_png) > 10000

        # 项目保存/载入往返
        proj = os.path.join(td, "p.json")
        import json
        with open(proj, "w") as f:
            json.dump(win._project_dict(), f)
        win2 = MainWindow()
        win2.img = img
        win2.img_path = img_path
        with open(proj) as f:
            d = json.load(f)
        assert len(d["curves"]) == 3 and len(d["quad"]) == 4
        print("项目往返 ok")

        # 格纸核对
        from pageflattener.gridcheck import run_grid_check
        report = run_grid_check(win.field, img.shape, td)
        assert "书脊侧" in report
        print("格纸核对 ok")

        # 视图绘制不报错
        win.resize(1200, 800)
        win.show()
        win.src_view.grab()
        win.out_view.grab()
        print("绘制 ok")

    print("\nGUI 冒烟测试 通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
