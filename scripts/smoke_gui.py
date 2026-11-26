"""离屏跑一遍完整工作流并截图, 供人工目检。

运行: .venv/bin/python scripts/smoke_gui.py
图片输出到 tmp/smoke/。
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PySide6.QtWidgets import QApplication  # noqa: E402

from trap_studio.app import (  # noqa: E402
    MainWindow,
    VIEW_DIFF,
    VIEW_OVERPRINT,
    VIEW_PAPER,
    VIEW_PLATE_A,
    VIEW_PLATE_B,
)

OUT = Path(__file__).resolve().parents[1] / "tmp" / "smoke"


def grab(win: MainWindow, name: str) -> None:
    pix = win.view._pixmap_item.pixmap()
    OUT.mkdir(parents=True, exist_ok=True)
    pix.save(str(OUT / f"{name}.png"))
    print(f"saved {name}.png  {pix.width()}x{pix.height()}")


def main() -> None:
    app = QApplication([])
    win = MainWindow()
    win.resize(1400, 950)
    win.show()
    app.processEvents()

    # 1. 默认叠色, 搭接开, 无偏移
    win.combo_view.setCurrentText(VIEW_OVERPRINT)
    win.spin_width.setValue(3.0)
    grab(win, "1_overprint_trap_on")

    # 2. 相同偏移下关搭接对比
    win.off_bx.setValue(4)
    win.off_ay.setValue(-3)
    grab(win, "2_offset_trap_on")
    win.btn_toggle.click()  # 关
    grab(win, "3_offset_trap_off")
    win.btn_toggle.click()  # 开回来

    # 3. 纸底/露白检查 + 探针
    win.combo_view.setCurrentText(VIEW_PAPER)
    win._on_probe(210, 120)  # 窄缝附近
    grab(win, "4_paper_probe")
    win.view.clear_markers()

    # 4. 单版
    win.combo_view.setCurrentText(VIEW_PLATE_A)
    grab(win, "5_plate_a")

    # 5. 最终像素变化 (原坐标)
    win.combo_view.setCurrentText(VIEW_DIFF)
    grab(win, "6_diff")

    # 6. 搭接宽度拉大到 8, 看薄指/尖角
    win.spin_width.setValue(8.0)
    win.combo_view.setCurrentText(VIEW_OVERPRINT)
    grab(win, "7_width8")

    # 7. 切换优先顺序: B 版扩向 A 版, 高亮仍应可见
    win.spin_width.setValue(3.0)
    win.radio_b.setChecked(True)
    win.combo_view.setCurrentText(VIEW_PLATE_B)
    grab(win, "8_spread_b_plate_b")
    win.combo_view.setCurrentText(VIEW_OVERPRINT)
    grab(win, "9_spread_b_overprint")
    win.radio_a.setChecked(True)

    print("\n".join(win._probe_text.text().splitlines()))
    print("OK")


if __name__ == "__main__":
    main()
