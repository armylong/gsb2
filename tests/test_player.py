"""播放引擎测试: 用 offscreen Qt 验证拉流设备行为, 不需要真实声卡。"""
import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import numpy as np
from PySide6.QtWidgets import QApplication

from blindabx.player import GaplessPlayer, _StreamDevice

app = QApplication.instance() or QApplication([])


def _pcm(buf: np.ndarray) -> bytes:
    return (np.clip(buf, -1, 1) * 32767).astype("<i2").tobytes()


def _make_buffers(frames: int = 4800, ch: int = 2) -> dict[str, bytes]:
    t = np.arange(frames) / frames
    return {
        "A": _pcm(np.repeat((0.25 * np.sin(2 * np.pi * 4 * t))[:, None], ch, 1)),
        "B": _pcm(np.repeat((0.75 * np.sin(2 * np.pi * 8 * t))[:, None], ch, 1)),
    }


class StreamDeviceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dev = _StreamDevice()
        self.bufs = _make_buffers()
        self.dev.configure(self.bufs, bytes_per_frame=4)
        self.dev.open(_StreamDevice.OpenModeFlag.ReadOnly)

    def tearDown(self) -> None:
        self.dev.close()

    def test_switching_source_keeps_position(self) -> None:
        self.dev.readData(4000)
        pos_before = self.dev.position_frames()
        self.assertEqual(self.dev.active, "A")
        self.dev.set_active("B")
        self.assertEqual(self.dev.active, "B")
        self.assertEqual(self.dev.position_frames(), pos_before)
        # 之后读出的字节确实来自 B
        chunk = self.dev.readData(8)
        self.assertEqual(chunk, self.bufs["B"][pos_before * 4: pos_before * 4 + 8])

    def test_loop_wraps_and_keeps_bounds(self) -> None:
        self.dev.set_loop(100, 200)
        self.dev.set_loop_mode(True)
        self.dev.seek_frames(198)
        data = self.dev.readData(16)  # 跨边界: 2 帧 + 回绕 2 帧
        self.assertEqual(len(data), 16)
        self.assertEqual(self.dev.position_frames(), 102)
        expect = (self.bufs["A"][198 * 4: 200 * 4]
                  + self.bufs["A"][100 * 4: 102 * 4])
        self.assertEqual(data, expect)

    def test_no_loop_emits_silence_past_end(self) -> None:
        # seek 到结尾之外: 读取全静音, 由上层定时器结束播放
        self.dev.seek_frames(self.dev.frame_count() + 10)
        data = self.dev.readData(100)
        self.assertEqual(data, b"\x00" * 100)

    def test_seek_clamped(self) -> None:
        self.dev.seek_frames(10 ** 9)
        self.assertLessEqual(self.dev.position_frames(), self.dev.frame_count())
        self.dev.seek_frames(-5)
        self.assertGreaterEqual(self.dev.position_frames(), 0)

    def test_loop_bounds_shared_across_sources(self) -> None:
        self.dev.set_loop(50, 500)
        self.dev.set_active("B")
        s, e = self.dev.loop_bounds_frames()
        self.assertEqual((s, e), (50, 500))


class GaplessPlayerWrapperTests(unittest.TestCase):
    def test_switch_does_not_change_position(self) -> None:
        player = GaplessPlayer()
        frames = 4800
        arrays = {
            "A": np.repeat(np.full((frames, 1), 0.1), 2, 1).astype(np.float32),
            "B": np.repeat(np.full((frames, 1), 0.4), 2, 1).astype(np.float32),
        }
        player.load(arrays, 48000, 2)
        target = 0.05  # 缓冲总时长 0.1s
        player.seek(target)
        player.switch_source("B")
        self.assertAlmostEqual(player.position(), target, places=4)
        self.assertEqual(player.active_source, "B")
        s, e = player.loop_bounds()
        self.assertAlmostEqual(e, player.duration(), places=3)
        player.stop()


if __name__ == "__main__":
    unittest.main()
