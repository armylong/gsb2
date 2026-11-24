from __future__ import annotations

import os
import unittest

import numpy as np

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QApplication

    from audio_quant_lab.dsp import AudioData
    from audio_quant_lab.main_window import MainWindow
except ImportError:  # pragma: no cover - optional GUI test environment
    QApplication = None  # type: ignore[assignment]


@unittest.skipIf(QApplication is None, "PySide6 is not installed")
class GuiSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def test_method_switching_retains_position_and_handles_edges(self) -> None:
        window = MainWindow()
        try:
            self.app.processEvents()
            n = window.audio.samples.size
            window.engine.seek(12_345)
            self.assertEqual(window.engine.position(), 12_345)

            for method in ("direct", "dither", "noise_shaped"):
                window.select_method(method)
                self.app.processEvents()
                self.assertEqual(window.quant_method, method)
                self.assertEqual(window.engine.position(), 12_345)
                self.assertEqual(window.output_wave.samples.size, n)

            window.bits_spin.setValue(4)
            window.recompute_results()
            self.app.processEvents()
            self.assertEqual(window.results["direct"].target_levels, 16)

            for samples in (
                np.zeros(1),
                np.zeros(3),
                np.sin(np.linspace(0, 2 * np.pi, 97)) * 0.999,
            ):
                window.load_audio(
                    AudioData(samples=samples, sample_rate=22_050, name="edge")
                )
                self.app.processEvents()
                pixmap = window.grab()
                self.assertFalse(pixmap.isNull())
        finally:
            window.close()
            window.deleteLater()
            self.app.processEvents()


if __name__ == "__main__":
    unittest.main()
