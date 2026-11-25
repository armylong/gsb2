"""GUI 冒烟测试 (offscreen): 窗口实例化、处理、轮次流程、导出。

不启动真实音频播放, 只验证控件状态机与信号路径。
"""
import json
import os
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QMessageBox

from blindabx.audio import PRESET_BY_KEY
from blindabx.main_window import MainWindow
from blindabx.workers import ProcessWorker

app = QApplication.instance() or QApplication([])

# offscreen 环境下模态消息框会永久阻塞, 统一打桩为直接返回
QMessageBox.information = staticmethod(lambda *a, **k: None)
QMessageBox.warning = staticmethod(lambda *a, **k: None)
QMessageBox.critical = staticmethod(lambda *a, **k: None)


class GuiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.win = MainWindow()
        worker = ProcessWorker("full", {
            "source_kind": "builtin", "source_key": "sample_quiet_tail",
            "setting_a": PRESET_BY_KEY["aac_96"],
            "setting_b": PRESET_BY_KEY["opus_64"],
            "alignment": True, "loudness_match": False,
        })
        failures: list[str] = []
        worker.failed.connect(failures.append)
        worker.finishedBundle.connect(cls.win._on_bundle)
        worker.run()  # 同步执行 run(), 不经事件循环
        app.processEvents()
        assert not failures, failures
        assert cls.win._bundle is not None

    def test_01_metrics_rendered(self) -> None:
        text = self.win._metrics_view.toPlainText()
        self.assertIn("AAC", text)
        self.assertIn("LUFS", text)
        self.assertIn("估计偏移", text)

    def test_02_round_flow_and_locking(self) -> None:
        win = self.win
        win._start_round()
        self.assertTrue(win._session.in_round)
        self.assertTrue(win._btn_x.isEnabled())
        self.assertFalse(win._btn_start.isEnabled())
        self.assertFalse(win._chk_align.isEnabled())
        # 轮次中拨动开关会被拒绝并恢复
        win._chk_align.setChecked(False)
        app.processEvents()
        self.assertTrue(win._bundle.alignment)
        # 空提交被拦截, 轮次仍在
        win._submit_round()
        self.assertTrue(win._session.in_round)
        # 作答
        win._rad_guess_a.setChecked(True)
        win._submit_round()
        self.assertFalse(win._session.in_round)
        self.assertTrue(win._btn_start.isEnabled())

    def test_03_cancel_not_scored(self) -> None:
        win = self.win
        before = len(win._session.answered_rounds())
        win._start_round()
        win._cancel_round()
        self.assertEqual(len(win._session.answered_rounds()), before)
        rec = win._session.export_record()
        self.assertEqual(rec["summary"]["answered_rounds"], before)

    def test_04_switch_preserves_position(self) -> None:
        win = self.win
        win._player.seek(0.05)
        win._switch("A")
        win._switch("B")
        self.assertAlmostEqual(win._player.position(), 0.05, delta=0.002)

    def test_05_export_payload(self) -> None:
        rec = self.win._session.export_record()
        self.assertEqual(rec["schema"], "blindabx-record/v1")
        self.assertGreaterEqual(rec["summary"]["answered_rounds"], 1)
        row = rec["rounds"][0]
        self.assertEqual(row["settings"]["setting_a"]["key"], "aac_96")
        self.assertEqual(row["settings"]["setting_b"]["key"], "opus_64")
        # 落盘验证 JSON 可序列化
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(rec, fh, ensure_ascii=False)
            path = fh.name
        with open(path, encoding="utf-8") as fh:
            loaded = json.load(fh)
        self.assertEqual(loaded["schema"], "blindabx-record/v1")
        os.unlink(path)

    def test_06_rebuild_toggle_outside_round(self) -> None:
        win = self.win
        self.assertFalse(win._session.in_round)
        worker = ProcessWorker("rebuild", {
            "bundle": win._bundle, "alignment": True, "loudness_match": True,
        })
        worker.finishedBundle.connect(win._on_bundle)
        failures: list[str] = []
        worker.failed.connect(failures.append)
        worker.run()
        app.processEvents()
        self.assertFalse(failures)
        self.assertTrue(win._bundle.loudness_match)
        self.assertTrue(win._bundle.gains)

    def test_07_x_source_stable_within_round(self) -> None:
        win = self.win
        win._start_round()
        rnd = win._session.current
        x_source = rnd.x_is
        # 在 A/B/X 之间来回切, 轮次对象的来源始终不变
        for _ in range(3):
            win._switch("A")
            win._switch("X")
            self.assertEqual(win._player.active_source, x_source)
            win._switch("B")
            win._switch("X")
            self.assertEqual(win._session.current.x_is, x_source)
        win._rad_guess_b.setChecked(True)
        win._submit_round()
        # 提交后揭示的答案与轮内实际一致
        self.assertEqual(win._revealed.x_is, x_source)

    def test_08_settings_change_starts_new_session_keeping_old(self) -> None:
        win = self.win
        old_session = win._session
        old_records = old_session.export_record()["rounds"]
        old_blind = old_session.settings.blind
        # 模拟改设置: 直接构造不同 settings 后开新一轮
        win._chk_blind.setChecked(not old_blind)
        win._blind_toggled()
        win._start_round()
        self.assertIsNot(win._session, old_session)
        self.assertIn(old_session, win._past_sessions)
        # 旧会话导出内容原样保留
        self.assertEqual(
            old_session.export_record()["rounds"], old_records)
        self.assertEqual(win._session.settings.blind, not old_blind)
        win._rad_guess_a.setChecked(True)
        win._submit_round()
        # 合并导出包含两个会话
        exported = [s.export_record() for s in win._all_sessions()]
        self.assertGreaterEqual(len(exported), 2)


if __name__ == "__main__":
    unittest.main()
