"""Smoke tests for the PySide6 GUI, run fully offscreen.

They are skipped automatically when PySide6 is not installed, so the core
tests stay runnable on a bare Python install.
"""

import os
import sys
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from PySide6.QtCore import QEventLoop, QTimer
    from PySide6.QtWidgets import QApplication, QLabel
except ImportError:  # pragma: no cover
    QApplication = None
    QLabel = None

from subtitle_tool.examples import build_example_project
from subtitle_tool.session import Session

_APP = None


def app():
    global _APP
    if _APP is None:
        _APP = QApplication.instance() or QApplication([])
    return _APP


@unittest.skipIf(QApplication is None, "PySide6 not installed")
class GuiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = app()

    def make_window(self):
        from subtitle_tool.gui.main_window import MainWindow

        window = MainWindow()
        window.show()
        window.on_load_example()
        window.pairing._apply_all()
        self.app.processEvents()
        return window

    def tearDown(self):
        if getattr(self, "window", None) is not None:
            self.window.session.dirty = False
            self.window.hide()
            self.window.deleteLater()
            self.app.processEvents()

    def test_example_loads_and_pairs(self):
        self.window = self.make_window()
        self.assertEqual(len(self.window.session.project.events), 8)
        self.assertEqual(self.window.preview.time_ms, 0)

    def test_apply_twice_does_not_duplicate(self):
        self.window = self.make_window()
        self.window.pairing._apply_all()
        self.app.processEvents()
        self.assertEqual(len(self.window.session.project.events), 8)

    def test_preview_at_missing_translation(self):
        self.window = self.make_window()
        self.window.on_time(12_700)
        self.app.processEvents()
        self.assertEqual(
            self.window.preview.screen.text(),
            "I'll signal you when the gate opens.",
        )

    def test_selection_loads_editor_fields(self):
        self.window = self.make_window()
        events = self.window.session.project.sorted_events()
        self.window.on_event_selected(events[1].eid)
        self.app.processEvents()
        self.assertIn("bridge", self.window.editor.texts["en"].toPlainText())
        self.assertIn("桥", self.window.editor.texts["zh"].toPlainText())

    def test_text_autosaves_and_is_undoable(self):
        self.window = self.make_window()
        ev = self.window.session.project.sorted_events()[3]
        self.window.on_event_selected(ev.eid)
        self.app.processEvents()
        self.window.editor.texts["zh"].setPlainText("我会在门开时给你信号。")
        loop = QEventLoop()
        QTimer.singleShot(900, loop.quit)
        loop.exec()
        self.assertEqual(
            self.window.session.project.event_by_id(ev.eid).text_for("zh"),
            "我会在门开时给你信号。",
        )
        self.window.on_undo()
        self.app.processEvents()
        self.assertEqual(
            self.window.session.project.event_by_id(ev.eid).text_for("zh"), ""
        )

    def test_lock_disables_time_and_split(self):
        self.window = self.make_window()
        ev = self.window.session.project.sorted_events()[0]
        self.window.on_event_selected(ev.eid)
        self.window.editor.lock_box.setChecked(True)
        self.app.processEvents()
        self.assertTrue(
            self.window.session.project.event_by_id(ev.eid).locked
        )
        self.assertFalse(self.window.editor.btn_split.isEnabled())
        self.assertFalse(self.window.editor.btn_apply_text.isEnabled())

    def test_timeline_click_updates_preview(self):
        self.window = self.make_window()
        self.window.on_time(20_500)
        self.assertEqual(
            self.window.preview.screen.text(), "Keep going,\n继续走，"
        )
        self.assertTrue(
            any(
                "ev6" in w.text()
                for w in self.window.preview.rows_holder.findChildren(QLabel)
            )
        )

    def test_export_and_verify_dialog(self):
        import tempfile

        from subtitle_tool.gui.verify_dialog import VerifyDialog

        self.window = self.make_window()
        with tempfile.TemporaryDirectory() as tmp:
            srt = os.path.join(tmp, "m.srt")
            manifest = os.path.join(tmp, "m.manifest.json")
            self.window.session.export_merged(srt, manifest)
            dialog = VerifyDialog(
                self.window.session.project, srt, manifest
            )
            self.assertTrue(dialog.report.ok)
            self.assertEqual(
                dialog.table.item(0, 5).text(), "一致"
            )

    def test_manual_dialog_pairs_and_marks_missing(self):
        from subtitle_tool.gui.manual_pair import ManualPairDialog

        self.window = self.make_window()
        # rebuild without the automatic pairing so nothing is already used
        self.window.session = Session(build_example_project())
        dialog = ManualPairDialog(self.window.session, self.window)
        self.assertEqual(dialog.left.list.count(), 7)
        dialog.left.list.item(0).setSelected(True)
        dialog.right.list.item(0).setSelected(True)
        dialog._pair()
        self.assertTrue(dialog.created)
        dialog.left.list.item(3).setSelected(True)
        dialog._missing("left")
        evs = self.window.session.project.sorted_events()
        missing = [e for e in evs if any(r.missing for r in e.rows)]
        self.assertTrue(missing)


if __name__ == "__main__":
    unittest.main()
