"""离屏 GUI 冒烟测试（不需要真实显示器，CI 可用）：

    QT_QPA_PLATFORM=offscreen python -I run_smoke.py
"""

import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6.QtWidgets import QApplication  # noqa: E402

from duotone.curves import ToneCurve  # noqa: E402
from duotone.gui.main_window import MainWindow  # noqa: E402


def main() -> int:
    app = QApplication([])
    win = MainWindow()
    win.show()

    # 等后台分色线程结束：processEvents 排空跨线程信号
    import time
    deadline = time.time() + 60
    while win._busy and time.time() < deadline:
        app.processEvents()
        if win._thread is not None:
            win._thread.wait(50)
        app.processEvents()
    assert not win._busy, "后台分色线程超时未完成"
    assert win.result is not None, "未产出管线结果"
    r = win.result
    assert r.a_final.shape == win.target_rgb.shape[:2]

    # 模拟交互：改 TAC、改曲线、探针
    win.spin_tac.setValue(1.1)
    app.processEvents()
    assert float((win.result.a_final + win.result.b_final).max()) <= 1.1 + 1e-9
    win.editor_a.set_curve(ToneCurve.gamma(1.6))
    win._on_curve_a(win.editor_a.curve())
    app.processEvents()
    probe = win.result.probe(10, 10)
    assert {"plate_a_raw", "plate_a_after_curve", "plate_a_final",
            "de00_raw", "de00_final"} <= set(probe)

    # 导出到临时目录
    import tempfile
    from duotone.export import export_all
    with tempfile.TemporaryDirectory() as d:
        paths = export_all(d, win.result, "smoke")
        assert os.path.exists(paths["plate_a"]) and os.path.getsize(paths["plate_a"]) > 0
        assert os.path.exists(paths["report"])

    print("SMOKE OK：GUI 实例化、后台分色、限墨、曲线、探针、导出 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
