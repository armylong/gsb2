"""GUI 烟囱测试：QT_QPA_PLATFORM=offscreen 下无需显示设备即可跑通完整工作流。"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtWidgets import QApplication

from entrance_reverb.dsp import read_wav
from entrance_reverb.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    work = tempfile.mkdtemp(prefix="gui_smoke_")

    # 1. 生成击掌信号（走和按钮完全相同的方法，只是目录不用对话框）
    from entrance_reverb.dsp import generate_test_claps
    paths = generate_test_claps(work)
    sr, audio = read_wav(paths["wav"])
    win.sr, win.dry, win.dry_path = sr, audio, paths["wav"]
    import csv
    win.markers = []
    first = 0
    with open(paths["markers"], newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            win.markers.append((int(row["sample"]), row["name"]))
            if row["name"] == "clap1":
                first = int(row["sample"])
    win.view.set_dry(audio, first, win.markers)
    win._set_controls_enabled(True)
    win._rebuild_ir()
    assert win.render is not None
    print(f"✓ 生成并渲染：{win.render.total_samples} 采样，prepend={win.render.prepend}")

    # 2. 三种视图切换
    for btn in win.view_group.buttons():
        btn.setChecked(True)
        win._on_view_changed()
        arr = win._current_view_audio()
        assert arr.shape == win.render.mix.shape
    print("✓ 干声 / 湿声 / 合成三视图切换，数组等长")

    # 3. 模拟波形控件点击改起音（真实路径是控件先更新自身再发信号）
    win.view.set_onset(first + 200)
    win.view.onsetChanged.emit(first + 200)
    assert win.view.onset_dry == first + 200
    win._render_timer.stop()
    win._render()
    print(f"✓ 点击改起音后重渲染，新 onset_index={win.render.onset_index}")

    # 4. 参数改动触发防抖渲染
    win.spin_lead.setValue(400.0)
    win.spin_fade.setValue(50.0)
    win.spin_wet.setValue(0.7)
    app.processEvents()
    win._render_timer.stop()
    win._render()
    assert win.render.fade_samples == int(0.05 * sr)
    print("✓ 参数（提前量/淡变/湿声音量）改动后重渲染")

    # 5. 内置 IR 切换
    win.ir_combo.setCurrentText("内置：一段衰减")
    assert win.ir is not None and win.ir.shape[0] == int(1.2 * sr)
    print(f"✓ 切换衰减 IR：{win.ir.shape}")

    # 6. 导出分轨并核对
    out = os.path.join(work, "export")
    os.makedirs(out)
    from entrance_reverb.dsp import write_wav
    r = win.render
    write_wav(os.path.join(out, "entrance_dry.wav"), r.sr, r.dry)
    write_wav(os.path.join(out, "entrance_wet_pre.wav"), r.sr, r.wet)
    write_wav(os.path.join(out, "entrance_mix.wav"), r.sr, r.mix)
    sr_d, dry_back = read_wav(os.path.join(out, "entrance_dry.wav"))
    sr_w, wet_back = read_wav(os.path.join(out, "entrance_wet_pre.wav"))
    sr_m, mix_back = read_wav(os.path.join(out, "entrance_mix.wav"))
    assert sr_d == sr_w == sr_m == sr
    assert dry_back.shape == wet_back.shape == mix_back.shape
    print("✓ 导出三个等长分轨 wav")

    # 7. player 载入（不真正出声）
    win._refresh_player_audio()
    assert not win.player._data.isEmpty()
    print("✓ 播放器载入 PCM 数据（offscreen 下不启动设备）")

    print("\nGUI 烟囱测试全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
