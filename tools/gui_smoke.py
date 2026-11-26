#!/usr/bin/env python3
"""GUI 离屏冒烟测试(也会被 verify.sh 调用)。

用 QT_QPA_PLATFORM=offscreen 真实创建主窗口、驱动控件、导出并回读,
同时把各阶段截图存到 tmp/screenshots/ 供人工查看。

运行:
    .venv/bin/python tools/gui_smoke.py
"""

from __future__ import annotations

import os
import struct
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from PySide6.QtWidgets import QApplication, QDialog, QFileDialog, QMessageBox  # noqa: E402
from PySide6.QtTest import QTest  # noqa: E402

from idxpng.png_io import PNG_SIGNATURE, _chunk, load_indexed_png, parse_chunks  # noqa: E402
from idxpng.render import render_rgba  # noqa: E402
from idxpng import main_window as mw  # noqa: E402

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  \033[32mPASS\033[0m  {name}" + (f" — {detail}" if detail else ""))
    else:
        failures.append(name)
        print(f"  \033[31mFAIL\033[0m  {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    shots = ROOT / "tmp" / "screenshots"
    shots.mkdir(parents=True, exist_ok=True)

    app = QApplication.instance() or QApplication(sys.argv)

    # 屏蔽所有模态弹窗的阻塞: 用子类替换 main_window 命名空间里的 QMessageBox
    class FakeMB(QMessageBox):
        def exec(self):  # noqa: N802
            return 0

        @staticmethod
        def information(*a, **k):
            return QMessageBox.StandardButton.Ok

        @staticmethod
        def warning(*a, **k):
            return QMessageBox.StandardButton.Ok

        @staticmethod
        def critical(*a, **k):
            return QMessageBox.StandardButton.Ok

        @staticmethod
        def question(*a, **k):
            return QMessageBox.StandardButton.Yes

    mw.QMessageBox = FakeMB
    mw.ReportDialog.exec = lambda self: QDialog.DialogCode.Accepted

    with tempfile.TemporaryDirectory(prefix="idxpng_gui_") as td:
        tmp = Path(td)

        class FakeFileDialog:
            @staticmethod
            def getExistingDirectory(*a, **k):
                return str(out_dir)

        win = mw.MainWindow()
        win.resize(1440, 900)
        win.show()
        QTest.qWait(200)
        win.grab().save(str(shots / "01_initial.png"))

        check("启动自动载入样本, 上下文为主图", win.ctx is win.master is not None)
        check("色表 8 行", win.table.rowCount() == 8, f"rows={win.table.rowCount()}")
        check("历史至少 1 步", win.history_list.count() >= 1)
        check("两张画布共享同一 ViewState",
              win.canvas_orig.state is win.canvas_cur.state is win.view_state)

        # ---- 选中 #2: 同色的 #3 不应被当作同一个可点项 ----
        win.table.selectRow(2)
        QTest.qWait(30)
        check("点选色表第 2 行 -> selected_index=2", win.selected_index == 2)
        win.grab().save(str(shots / "02_select_index2_highlight.png"))
        win.canvas_cur.grab().save(str(shots / "02b_canvas_highlight2.png"))

        # ---- 改 #2 的颜色与透明度 ----
        win.spin_r.setValue(18)
        win.spin_g.setValue(214)
        win.spin_b.setValue(116)
        win.spin_a.setValue(220)
        QTest.qWait(60)
        doc = win.ctx.doc
        check("Spin 改色写入 #2", doc.palette[2] == (18, 214, 116, 220), str(doc.palette[2]))
        check("同色异号 #3 保持原红不被连带修改",
              doc.palette[3] == (239, 83, 80, 255), str(doc.palette[3]))
        win.grab().save(str(shots / "03_recolor_index2.png"))

        # ---- 点击像素: 同时读两个索引 ----
        x2, y2 = doc.positions_of(2)[0]
        win.inspect_pixel(x2, y2)
        text = win.readout.text()
        check("点击像素的读报包含位置", f"x={x2}" in text and f"y={y2}" in text)
        check("读报同时给出现图 #2", "现图索引 → #2" in text)
        check("读报同时给出原图 #2", "原图/起点索引 → #2" in text)

        # ---- 保外观重编号: 移动 #2 -> #3, 渲染必须逐字节不变 ----
        before = render_rgba(win.ctx.doc, outline=False)
        win.selected_index = 2
        win.move_selected(1)
        QTest.qWait(30)
        after = render_rgba(win.ctx.doc, outline=False)
        check("上移/下移重编号后渲染逐字节一致", before == after)
        check("移动后选中新编号 #3", win.selected_index == 3)
        win.grab().save(str(shots / "04_renumber_preserve_look.png"))

        # ---- 历史跳回起点 ----
        win.history_list.setCurrentRow(0)
        QTest.qWait(30)
        check("历史跳回第 0 步: #2 颜色还原",
              win.ctx.doc.palette[2] == (239, 83, 80, 255))
        check("历史跳回第 0 步: 索引还原",
              win.ctx.doc.indices == win.master.base.indices)
        win.grab().save(str(shots / "05_history_jump_start.png"))

        # 回到最新步, 继续后续操作
        last_row = win.history_list.count() - 1
        win.history_list.setCurrentRow(last_row)
        QTest.qWait(20)

        # ---- 交换外观对话框(打桩选择 #1/#4) ----
        class FakeTwoIndex:
            def __init__(self, palette, first, *a, **k):
                pass

            def exec(self):
                return QDialog.DialogCode.Accepted

            def indexes(self):
                return 1, 4

        orig_dlg = mw.TwoIndexDialog
        mw.TwoIndexDialog = FakeTwoIndex
        pal_before = tuple(win.ctx.doc.palette)
        win.swap_appearance_dialog()
        mw.TwoIndexDialog = orig_dlg
        check("交换外观: #1/#4 RGBA 互换",
              win.ctx.doc.palette[1] == pal_before[4]
              and win.ctx.doc.palette[4] == pal_before[1])
        check("交换外观新增一条历史", win.history_list.currentRow() == win.history_list.count() - 1)

        # ---- 创建 A/B 版本(弹窗已打桩) ----
        win.create_ab_versions()
        QTest.qWait(30)
        check("创建两个版本", len(win.versions) == 2)
        check("创建后切到版本 A", win.ctx is win.versions[0])
        check("A/B 起点索引相同",
              win.versions[0].base.indices == win.versions[1].base.indices)
        check("A/B 起点来自 master 当前编号图",
              win.versions[0].base.indices == win.master.doc.indices)

        # A 改半透明
        win.table.selectRow(7)
        win.spin_a.setValue(96)
        QTest.qWait(40)
        check("版本 A 的 #7 alpha=96", win.versions[0].doc.palette[7][3] == 96)

        # 切到 B 改 #3
        win.context_list.setCurrentRow(2)
        QTest.qWait(30)
        check("上下文列表切到版本 B", win.ctx is win.versions[1])
        win.table.selectRow(3)
        win.spin_r.setValue(12)
        win.spin_g.setValue(120)
        QTest.qWait(40)
        check("版本 B 改了 #3", win.versions[1].doc.palette[3][1] == 120)
        check("A 的修改不影响 B", win.versions[0].doc.palette[7][3] == 96)
        win.grab().save(str(shots / "06_version_B.png"))

        # 回主图
        win.context_list.setCurrentRow(0)
        QTest.qWait(20)
        check("切回主图上下文", win.ctx is win.master)

        # ---- 批量导出(目录对话框打桩) + 报告不阻塞 ----
        out_dir = tmp / "batch"
        out_dir.mkdir()
        mw.QFileDialog = FakeFileDialog
        win.export_versions()
        QTest.qWait(60)
        pngs = sorted(out_dir.glob("*.png"))
        check("批量导出 2 个 PNG", len(pngs) == 2, ", ".join(p.name for p in pngs))
        all_reports_ok = all(all(c.ok for c in checks) for _, _, checks in win.last_export_records)
        check("GUI 导出后的回读核对全部 PASS", all_reports_ok)

        # 重新读回按钮也跑一遍
        win.reread_last()
        QTest.qWait(30)

        # 报告对话框截图(非模态 show 后 grab)
        report = mw.ReportDialog(win.last_export_records, win)
        report.show()
        QTest.qWait(120)
        report.grab().save(str(shots / "08_verify_report.png"))
        report.close()

        # 右侧滚到底, 确认版本/导出控件完整可见可用
        win.right_scroll.verticalScrollBar().setValue(
            win.right_scroll.verticalScrollBar().maximum()
        )
        QTest.qWait(80)
        win.grab().save(str(shots / "09_export_panel.png"))
        win.right_scroll.verticalScrollBar().setValue(0)
        QTest.qWait(40)

        # 从磁盘独立验证是索引色且重复槽位仍在
        for p in pngs:
            info = parse_chunks(p)
            check(f"{p.name} color_type=3", info.color_type == 3)
            check(f"{p.name} PLTE=8 格(未合并)", info.plte is not None and len(info.plte) == 8)
            loaded = load_indexed_png(p)
            check(f"{p.name} Pillow mode=P", True)  # load_indexed_png 非 P 会直接抛错

        # ---- 打开普通 RGBA: 说明原因并保留现有编辑 ----
        rgba_path = tmp / "normal_rgba.png"
        from PIL import Image
        Image.new("RGBA", (9, 5), (200, 30, 40, 180)).save(rgba_path)
        master_before = win.master
        rows_before = win.table.rowCount()
        win.open_path(rgba_path)
        QTest.qWait(30)
        check("打开 RGBA 后仍是原 master 对象(编辑保留)", win.master is master_before)
        check("打开 RGBA 后上下文未变", win.ctx is win.master)
        check("色表行数保持 8", win.table.rowCount() == rows_before == 8)

        # ---- 色表不足文件: 能诊断位置 ----
        raw = (ROOT / "samples" / "sample_odd11_duplicate_alpha_4bit.png").read_bytes()
        truncated = bytearray(PNG_SIGNATURE)
        off = 8
        while off + 8 <= len(raw):
            ln = struct.unpack(">I", raw[off:off + 4])[0]
            typ = raw[off + 4:off + 8]
            data = raw[off + 8:off + 8 + ln]
            off += 12 + ln
            if typ == b"PLTE":
                data = data[:5 * 3]
            elif typ == b"tRNS":
                data = data[:5]
            truncated += _chunk(typ, data)
        gap_path = tmp / "gap.png"
        gap_path.write_bytes(bytes(truncated))
        win.open_path(gap_path)  # question 已打桩为 Yes, gap 消息框 exec 已打桩
        QTest.qWait(40)
        check("缺色表文件打开后色表 5 行", win.table.rowCount() == 5)
        check("诊断出 #5/#6/#7 缺失", win.master.doc.gap_indices() == [5, 6, 7])
        pos7 = win.master.doc.gap_positions()[7]
        check("给出 #7 的具体位置", len(pos7) == 8 and pos7[0] is not None)
        win.grab().save(str(shots / "07_gap_palette_warning.png"))

        print(f"\n截图已保存到 {shots}")

    print("\n" + "=" * 60)
    if failures:
        print(f"\033[31mGUI 冒烟失败 {len(failures)} 项: {failures}\033[0m")
        return 1
    print("\033[32mGUI 离屏冒烟全部通过\033[0m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
