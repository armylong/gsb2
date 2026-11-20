"""GUI 冒烟测试：在 offscreen Qt 平台下驱动主窗口的主要交互。

不做像素级断言，只验证控件联动、后台线程、子窗口与导出路径不报错。
运行：QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke_gui.py
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtCore import QEventLoop, QTimer  # noqa: E402

from bandviewer.app import CompareDialog, MainWindow, ZoomDialog  # noqa: E402
from bandviewer.quantize import METHODS  # noqa: E402


def pump(ms: int = 200) -> None:
    """让事件循环跑一会儿，等后台计算线程收尾。"""
    loop = QEventLoop()
    QTimer.singleShot(ms, loop.quit)
    loop.exec()


def wait_result(win, previous=None, timeout_ms: int = 15000) -> object:
    """轮询事件循环，直到后台量化计算产出新结果，返回该结果。

    若该操作根本没有触发重算（例如 combo 已是目标索引，信号不发射），
    则没有线程在跑，直接返回当前结果，避免死等。
    """
    if win._thread is None and win.result is previous:
        pump(50)
        if win._thread is None:
            return win.result
    elapsed = 0
    step = 100
    while elapsed < timeout_ms:
        pump(step)
        elapsed += step
        if win.result is not None and win.result is not previous:
            return win.result
    raise AssertionError("后台计算超时未完成")


def main() -> int:
    from PySide6.QtWidgets import QApplication, QMessageBox
    qapp = QApplication.instance() or QApplication(sys.argv)  # 保活引用，不能省
    assert qapp is not None

    # 无头环境下把模态警告替换成记录调用，避免阻塞
    warnings: list[str] = []
    QMessageBox.warning = staticmethod(lambda *a, **kw: warnings.append(str(a)) or QMessageBox.StandardButton.Ok)

    win = MainWindow()
    win.show()
    r0 = wait_result(win)
    assert win.hist_table.rowCount() >= 2

    # 每次交互前先空转一拍，保证上一轮的重算信号已进入事件循环，
    # 否则连续触发会被 _pending 合并，wait_result 会等不到对应结果对象。
    # 切换所有图案（每次切换都会触发后台重算）
    prev = r0
    for i in range(win.pattern_combo.count()):
        pump()
        win.pattern_combo.setCurrentIndex(i)
        prev = wait_result(win, prev)
    print(f"[OK] 切换 {win.pattern_combo.count()} 种测试图")

    # 切换所有量化方法（FS 最慢，统一等待）
    for i, method in enumerate(METHODS):
        pump()
        win.method_combo.setCurrentIndex(i)
        prev = wait_result(win, prev)
        assert win.method_combo.currentData() == method
    print(f"[OK] 切换 {len(METHODS)} 种量化方法")

    # 改级别设置（等距 / gamma / 自定义）
    pump(); win.count_spin.setValue(12)
    prev = wait_result(win, prev)
    pump(); win.spacing_combo.setCurrentIndex(1)
    pump(); win.gamma_spin.setValue(2.2)
    prev = wait_result(win, prev)
    pump(); win.custom_edit.setText("0 24 48 96 160 255")
    pump(); win.apply_custom_levels()
    prev = wait_result(win, prev)
    assert win._custom_levels is not None and win._custom_levels.size == 6
    pump(); win.clear_custom_levels()
    prev = wait_result(win, prev)
    print("[OK] 灰阶方案与自定义级别联动")

    # 噪声强度与种子（两次改动会合并成一次重算，循环等到新结果即可）
    pump(); win.noise_spin.setValue(0.05)
    pump(); win.seed_spin.setValue(7)
    prev = wait_result(win, prev)
    win.boundary_check.setChecked(False)
    win.boundary_check.setChecked(True)
    print("[OK] 噪声参数与边界叠加开关")

    # 局部放大窗口
    win.open_zoom(50, 60)
    pump(100)
    zoom = win._zoom_dlg
    assert isinstance(zoom, ZoomDialog)
    zoom.x_spin.setValue(70)
    zoom.zoom_combo.setCurrentText("16")
    zoom.half_combo.setCurrentText("24")
    zoom.boundary_toggle.setChecked(False)
    pump(100)
    assert zoom.cx == 70 and zoom.zoom == 16 and zoom.half == 24
    print("[OK] 局部放大窗口（真实像素、坐标/倍数/半宽联动）")

    # 方法比较窗口
    win.open_compare()
    pump(500)
    assert isinstance(win._compare_dlg, CompareDialog)
    print("[OK] 多量化方法并排比较窗口")

    # 导出
    outdir = os.path.join("tmp", "smoke")
    os.makedirs(outdir, exist_ok=True)
    gray_path = os.path.join(outdir, "gui_gray.png")
    err_path = os.path.join(outdir, "gui_error.png")
    # 直接绕过文件对话框，调用底层写盘
    from bandviewer.pngio import write_png
    write_png(gray_path, win.result["q"], win.result["alpha"])
    write_png(err_path, win.result["err_rgb"], win.result["alpha"])
    assert os.path.getsize(gray_path) > 0 and os.path.getsize(err_path) > 0
    print(f"[OK] 导出 {gray_path} / {err_path}")

    # 错误的自定义级别要弹警告而不是崩溃（QMessageBox 已被替换为非阻塞）
    win.custom_edit.setText("123")
    win.apply_custom_levels()
    pump(50)
    assert win._custom_levels is None and warnings, "非法级别未触发警告"
    print("[OK] 非法自定义级别被拒绝")

    print("\nGUI 冒烟测试全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
