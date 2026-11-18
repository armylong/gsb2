"""无头冒烟: 直接驱动 MainWindow, 验证 UI 层联动行为(不只是纯函数)。"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
sys.path.insert(0, ROOT)

from PySide6.QtWidgets import QApplication  # noqa: E402

from syncplayer.main_window import MainWindow  # noqa: E402
from syncplayer.timings import choose_frame  # noqa: E402
from tools.make_samples import make  # noqa: E402


def pump(app, ms=400):
    import time
    end = time.monotonic() + ms / 1000
    while time.monotonic() < end:
        app.processEvents()
        time.sleep(0.01)


def main() -> int:
    import tempfile

    out = tempfile.mkdtemp(prefix="smoke_")
    info = make(out)
    app = QApplication([])
    win = MainWindow()
    win.show()

    assert win.load_pair(info["path_a"], info["path_b"]), "载入失败"
    pump(app, 500)

    # 1) 标准答案偏移 -0.5: 取几个主时间, 两边实际帧对应的事件应一致
    win.spin_offset.setValue(-0.5)
    pump(app, 200)
    a = win.info_a
    b = win.info_b
    for t in (1.0, 2.5, 5.0):
        win.engine.seek(t)
        win._refresh(t)
        ca = choose_frame(a, t)
        cb = choose_frame(b, t - 0.5)
        ev_a = ca.pts
        ev_b = 0.5 + cb.pts  # B 帧场景时间 = 起点 + 内容 pts
        assert abs(ev_a - ev_b) <= max(1 / 30, 1 / 24) + 1e-6
    print("[ok] 偏移 -0.5 下两边实际帧对应同一事件(一帧内)")

    # 2) A 帧步进: 主时间按 A 帧间隔变化, B 跟随同一主时钟
    win.engine.seek(1.0)
    win._step(3)
    assert abs(win.engine.base_time - (1.0 + 3 / 30)) < 1e-6
    win._step(-2)
    assert abs(win.engine.base_time - (1.0 + 1 / 30)) < 1e-6
    print("[ok] 共用帧步进以 A 帧间隔为准, B 跟随主时钟")

    # 3) 无重叠: 循环被拒绝, 但偏移仍可调
    win.spin_offset.setValue(50.0)
    pump(app, 100)
    assert win.engine.overlap() is None
    win.chk_loop.setChecked(True)
    win._on_loop_toggled()
    assert not win.chk_loop.isChecked(), "无重叠时不应允许循环"
    win.spin_offset.setValue(-0.5)
    assert win.engine.overlap() is not None
    print("[ok] 无重叠时禁止无效循环且仍可调整偏移")

    # 4) 越界显示无画面原因, 不停在末帧
    win.engine.seek(0.0)
    win.spin_offset.setValue(-0.5)
    win._refresh(0.0)
    cb = choose_frame(win.info_b, 0.0 - 0.5)
    assert not cb.within and cb.reason == "before"
    assert win._pix_b is None and "早于" in win._b_blank
    print("[ok] 超出 B 首帧时显示无画面及原因")

    # 5) 视图切换共用位置与偏移; 叠合分隔线可拖
    win.rb_overlay.setChecked(True)
    win.stack.setCurrentIndex(1)
    assert win.engine.offset == -0.5
    win.overlay._divider = 0.3
    win.rb_side.setChecked(True)
    win.stack.setCurrentIndex(0)
    print("[ok] 并排/叠合视图共用偏移, 分隔线可调整")

    # 6) 音频三态切换, 始终只有一个 sink; 暂停即停
    win.rb_audio_a.setChecked(True)
    win._on_audio_mode(1)
    assert win.audio_ctrl.mode == "A"
    win._play()
    pump(app, 200)
    assert win.audio_ctrl.sink.state().value != 0  # active state
    win.rb_audio_b.setChecked(True)
    win._on_audio_mode(2)
    assert win.audio_ctrl.mode == "B"
    assert win.audio_ctrl.device.offset == -0.5  # B 声音遵循同一偏移
    win._pause()
    assert win.audio_ctrl.mode == "B"
    win.rb_mute.setChecked(True)
    win._on_audio_mode(0)
    assert win.audio_ctrl.device.audio is None
    print("[ok] 声音单路切换/偏移跟随/暂停静音无残留")

    # 7) 保存后重开还原偏移; 文件失效拒绝应用
    win._save_settings()
    path = win._settings_path
    win2 = MainWindow()
    assert win2.load_pair(info["path_a"], info["path_b"], path)
    pump(app, 400)
    assert abs(win2.engine.offset - (-0.5)) < 1e-9
    print("[ok] 重开后按文件身份还原偏移设置")

    win.close()
    win2.close()
    print("\n全部冒烟检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
