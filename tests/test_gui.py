"""GUI 冒烟测试:离屏实例化主窗口,跑通 加载→分析→配对→导出 全流程。"""
import os

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import csv
import math

import pytest

from fiber_measure.ui.main_window import MainWindow


@pytest.fixture(scope="module")
def qapp():
    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication([])
    yield app


def test_sample_flow(qapp, tmp_path):
    win = MainWindow()
    win._load_sample("crossing")
    # 分析已自动执行:5 条路径(2 对角线 + T 三支)
    assert win.tbl.rowCount() == 5
    assert win.lst_cross.count() == 1
    # 表格含像素长与实际长两列,刻度 0.5 µm/px
    px = float(win.tbl.item(0, 2).text())
    real = win.tbl.item(0, 3).text()
    assert px > 0 and real.endswith("µm")

    # 切换交叉配对 → 路径与列表一起更新
    before = [win.tbl.item(r, 2).text() for r in range(win.tbl.rowCount())]
    win.lst_cross.setCurrentRow(0)
    win._cycle_pairing(1)
    after = [win.tbl.item(r, 2).text() for r in range(win.tbl.rowCount())]
    assert before != after
    assert "配对 2/3" in win.lst_cross.item(0).text()
    # 标记状态显示适用于当前参数
    assert "1 条" in win.lbl_marks.text()

    # 改阈值 → 签名变化,重算后标记按位置匹配仍有效
    sig_before = win.lbl_sig.text()
    win.sld_thr.setValue(100)
    win._reanalyze()
    assert win.lbl_sig.text() != sig_before
    assert "失效" not in win.lbl_marks.text()

    # 导出
    png = tmp_path / "a.png"
    csv_path = tmp_path / "m.csv"
    import fiber_measure.ui.main_window as mw
    orig = mw.QFileDialog.getSaveFileName
    mw.QFileDialog.getSaveFileName = staticmethod(lambda *a, **k: (str(png), ""))
    win._export_image()
    mw.QFileDialog.getSaveFileName = staticmethod(lambda *a, **k: (str(csv_path), ""))
    win._export_csv()
    mw.QFileDialog.getSaveFileName = orig
    assert png.exists() and csv_path.exists()
    rows = list(csv.reader(open(csv_path, encoding="utf-8-sig")))
    assert len(rows) == 1 + win.tbl.rowCount()
    assert rows[0][:4] == ["path_id", "类型", "像素长", "实际长"]
    win.close()


def test_loop_sample_selectable(qapp):
    win = MainWindow()
    win._load_sample("loop")
    assert win.tbl.rowCount() == 1
    assert win.tbl.item(0, 1).text() == "闭环"
    px = float(win.tbl.item(0, 2).text())
    assert px == pytest.approx(2 * math.pi * 80, rel=0.05)
    # 闭环也能被选中高亮
    win.tbl.selectRow(0)
    assert win._selected_path_id == 0
    win.close()


def test_binary_mask_input(qapp):
    import numpy as np, cv2
    mask_img = np.zeros((100, 200, 3), np.uint8)
    cv2.line(mask_img, (10, 50), (190, 50), (255, 255, 255), 3)
    win = MainWindow()
    win._set_image(mask_img, image_id="test:binary", sample_meta=None)
    assert win._params.binary_input
    assert not win.sld_thr.isEnabled()
    assert win.tbl.rowCount() == 1
    px = float(win.tbl.item(0, 2).text())
    assert px == pytest.approx(180, rel=0.05)
    win.close()
