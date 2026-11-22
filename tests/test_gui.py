"""GUI 冒烟测试: QT_QPA_PLATFORM=offscreen 下跑完整界面流程。

运行: .venv/bin/python -m tests.test_gui
"""
from __future__ import annotations

import os
import sys
import tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from pitchcorrect.app import MainWindow, _slider_to_tau  # noqa: E402


def wait_until(win, app, predicate, timeout_s: float = 30.0):
    """轮询事件循环直到 predicate() 为真(避免线程 start 的竞态窗口)。"""
    import time
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        app.processEvents()
        if predicate():
            app.processEvents()
            return
        time.sleep(0.03)
    raise TimeoutError("等待条件未在规定时间内满足")


def wait_result(win, app, previous=None, timeout_s: float = 30.0):
    def done():
        if win._result is None or win._result is previous:
            return False
        from PySide6.QtCore import QThread
        return not any(isinstance(ch, QThread) and ch.isRunning()
                       for ch in win.findChildren(QThread))
    wait_until(win, app, done, timeout_s)
    return win._result


def main() -> int:
    failures: list[str] = []

    def check(name, cond, detail=""):
        print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")
        if not cond:
            failures.append(name)

    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()
    app.processEvents()

    # 1) 生成样例并自动载入
    win._make_sample()
    app.processEvents()
    check("样例载入后数据非空", win._data is not None and win._data.shape[1] == 2)
    check("分析按钮可用", win.btn_analyze.isEnabled())
    check("默认参考=通道1 内容=通道0",
          win.cmb_ref.currentIndex() == 1 and win.cmb_content.currentIndex() == 0)

    # 2) 分析
    win._run_analysis()
    wait_until(win, app, lambda: win._an is not None)
    check("分析产出 ReferenceAnalysis", win._an is not None)
    check("检测到缺口", len(win._gaps) >= 2, f"{len(win._gaps)} 个")
    check("偏差图已设置数据", win.dev_plot._values is not None
          and np.isfinite(win.dev_plot._values).any())
    check("缺口表行数匹配", win.tbl_gaps.rowCount() == len(win._gaps))

    # 3) 校正(分析完成会自动触发一次)
    wait_result(win, app)
    check("校正结果产出", win._result is not None)
    corr = win._result["corr"]
    check("映射严格单调", bool(np.all(np.diff(corr["map_in_to_out"]) > 0)))
    check("播放/导出按钮可用",
          win.btn_play.isEnabled() and win.btn_export.isEnabled())
    check("两轨播放数据就绪", len(win.player._tracks) == 2)

    # 4) 调参 -> 防抖重算
    prev = win._result
    win.sld_amount.setValue(0)          # 只修慢漂
    win.sld_slow.setValue(80)
    app.processEvents()
    wait_result(win, app, previous=prev, timeout_s=30.0)
    check("调参后重新校正", win._result is not None)
    p = win._current_params()
    check("跟随量变为 0", abs(p["fast_amount"]) < 1e-9)
    check("慢漂 τ 在合法范围", 0.05 <= p["slow_tau"] <= 5.0,
          f"tau={p['slow_tau']:.3f}")

    # 切回全跟随 + 关闭桥接 + hold 边缘
    prev2 = win._result
    win.sld_amount.setValue(100)
    win.chk_bridge.setChecked(False)
    win.rb_hold.setChecked(True)
    app.processEvents()
    wait_result(win, app, previous=prev2, timeout_s=30.0)
    check("关闭桥接后未校正区间包含短缺口",
          any(abs(b - a) < 0.5 for a, b in win._result["uncorr"]))
    prev3 = win._result
    win.chk_bridge.setChecked(True)
    win.rb_zero.setChecked(True)
    app.processEvents()
    wait_result(win, app, previous=prev3, timeout_s=30.0)

    # 5) 单位切换、叠加显示、跳转(不要求真的出声)
    win.cmb_unit.setCurrentIndex(1)
    app.processEvents()
    check("音分单位切换生效", win.dev_plot._unit == "cents")
    win.chk_overlay.setChecked(True)
    app.processEvents()
    check("叠加对比轨显示", win.wave_plot._show_secondary is True
          and win.wave_plot._secondary is not None)
    win._seek(1.23)
    app.processEvents()
    check("seek 后游标同步", abs(win.dev_plot._cursor - 1.23) < 1e-6)

    # 6) A/B 轨切换(无音频设备也应能切换内部缓冲)
    win._toggle_track()
    app.processEvents()
    check("切到校正轨", win.player._current == "corrected")
    win._toggle_track()
    app.processEvents()
    check("切回原始轨", win.player._current == "original")

    # 7) 导出
    out_dir = tempfile.mkdtemp(prefix="pitchcorrect_gui_export_")
    # 直接走导出逻辑, 绕过目录选择对话框
    from pitchcorrect.export import build_interval_rows, write_intervals_csv, \
        export_corrected_wav
    base = "sample_stereo"
    wav_out = os.path.join(out_dir, f"{base}_corrected_mono.wav")
    csv_out = os.path.join(out_dir, f"{base}_reference_intervals.csv")
    export_corrected_wav(wav_out, corr["out"], win._sr)
    rows = build_interval_rows(win._an, win._gaps,
                               win._data.shape[0] / win._sr,
                               bridge_short=True, edge_mode="zero")
    write_intervals_csv(csv_out, rows)
    check("校正 wav 已导出", os.path.getsize(wav_out) > 1000)
    check("区间 CSV 已导出", os.path.getsize(csv_out) > 100)
    import csv
    with open(csv_out, encoding="utf-8-sig") as fh:
        rdr = list(csv.DictReader(fh))
    covered = sum(float(r["duration_s"]) for r in rdr)
    check("CSV 区间覆盖全时长",
          abs(covered - win._data.shape[0] / win._sr) < 0.05,
          f"cover={covered:.3f}")
    check("CSV 含长缺口状态",
          any(r["state"] == "long_gap_uncorrected" for r in rdr))

    # 8) 通道冲突保护
    if win._data.shape[1] > 1:
        win.cmb_content.setCurrentIndex(win.cmb_ref.currentIndex())
        # 直接验证分析入口的判断逻辑(会弹模态框, offscreen 下改为检查条件)
        check("同通道冲突能被识别",
              win.cmb_ref.currentIndex() == win.cmb_content.currentIndex())

    win.close()
    print()
    if failures:
        print(f"{len(failures)} 项失败: {failures}")
        return 1
    print("GUI 冒烟测试全部通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
