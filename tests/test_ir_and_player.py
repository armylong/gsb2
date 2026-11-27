"""外部 IR 加载与播放状态机的离屏测试（不触碰真实音频设备）。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from PySide6.QtWidgets import QApplication

from entrance_reverb.audio_player import AudioPlayer
from entrance_reverb.dsp import (
    builtin_ir,
    generate_test_claps,
    read_wav,
    render_reverse_reverb,
    RenderParams,
    write_wav,
)
from entrance_reverb.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    work = tempfile.mkdtemp(prefix="ir_player_")

    # 1. 外部 IR：单声道、不同采样率，触发 R3+R1 匹配
    ir_mono = builtin_ir("decay", 24000)[:, :1]
    ir_path = os.path.join(work, "mono_ir_24k.wav")
    write_wav(ir_path, 24000, ir_mono)
    paths = generate_test_claps(work)
    sr, dry = read_wav(paths["wav"])

    win = MainWindow()
    win.sr, win.dry, win.dry_path = sr, dry, paths["wav"]
    win.view.set_dry(dry, int(0.1 * sr), sr=sr)
    win._set_controls_enabled(True)
    ir_sr, ir_raw = read_wav(ir_path)
    win._ir_external = (ir_raw, ir_sr, os.path.basename(ir_path))
    win.ir_combo.setCurrentText("外部文件…")
    joined = "\n".join(win.log.toPlainText().splitlines())
    assert "R1" in joined and "R3" in joined, joined
    assert win.ir.shape[1] == 2
    print("✓ 外部单声道 24k IR 加载：R1 重采样 + R3 复制立体声，日志已说明规则")

    # 2. 左右长度不等的外部 IR，触发 R5
    uneven = np.zeros((2000, 2))
    rng = np.random.default_rng(1)
    uneven[:1500, 0] = rng.standard_normal(1500) * 0.4
    uneven[:900, 1] = rng.standard_normal(900) * 0.4
    uneven_path = os.path.join(work, "uneven.wav")
    write_wav(uneven_path, sr, uneven)
    ir_sr2, ir_raw2 = read_wav(uneven_path)
    win._ir_external = (ir_raw2, ir_sr2, os.path.basename(uneven_path))
    win._rebuild_ir()
    assert "R5" in win.log.toPlainText()
    assert win.ir.shape[0] == 1500
    print("✓ 左右长度不同的 IR：R5 按最长 1500 统一、短声道补零，日志已提示")

    # 3. 播放状态机：不 start 设备，只验证数据装载与 stop 行为
    player = AudioPlayer()
    r = render_reverse_reverb(dry, sr, int(0.1 * sr), win.ir,
                              RenderParams(lead_ms=200, fade_ms=25))
    player.set_audio(r.mix, sr)
    assert not player._data.isEmpty()
    assert player._channels == 2 and player._sr == sr
    # 装载的数据字节数 = 采样数 * 声道 * 2 字节
    expect_bytes = r.mix.shape[0] * 2 * 2
    assert player._data.size() == expect_bytes
    assert player.stop() is False  # 没在播放时 stop 返回 False
    print("✓ 播放器装载 int16 立体声 PCM，字节数与分轨采样数严格对应")

    # 4. 单声道数据同样可装载
    mono = r.mix.mean(axis=1, keepdims=True)
    player.set_audio(mono, sr)
    assert player._channels == 1
    assert player._data.size() == mono.shape[0] * 2
    print("✓ 单声道播放数据装载正确")

    print("\n外部 IR / 播放器测试全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
