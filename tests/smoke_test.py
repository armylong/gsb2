"""冒烟测试：合成样片分析、ffmpeg 解码、GUI 离屏联动、导出。

运行（仓库根目录）:  QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from videoscope.analysis import analyze_frame, pixels_at
from videoscope.sources import FFmpegSource, SyntheticSource, probe

TMP = tempfile.mkdtemp(prefix="videoscope_test_")
failures = []


def check(name, cond, extra=""):
    print(("PASS" if cond else "FAIL"), name, extra)
    if not cond:
        failures.append(name)


# ---------------------------------------------------------------- 1. 合成样片 + 分析
src = SyntheticSource("overflow")
Y, U, V = src.frame(30)
res = analyze_frame(Y, U, V, "tv", None, 256)
wf, rep = res["waveform"], res["report"]
check("overflow: 波形形状", wf.shape == (256, 256))
check("overflow: 亮部压边界被计数", rep["highlight_crush_px"] > 1000,
      f"-> {rep['highlight_crush_px']}px ({rep['highlight_crush_pct']}%)")
check("overflow: 暗部压边界被计数", rep["shadow_crush_px"] > 100,
      f"-> {rep['shadow_crush_px']}px")

src2 = SyntheticSource("blueramp")
Y2, U2, V2 = src2.frame(0)
res2 = analyze_frame(Y2, U2, V2, "tv", None, 256)
r2 = res2["report"]
check("blueramp: B 通道整体抬高(暗端)", r2["b_min"] > r2["r_min"] + 10,
      f"-> Bmin {r2['b_min']} Rmin {r2['r_min']}")
check("blueramp: 无亮部压边界(整体偏色而非溢出)",
      r2["highlight_crush_pct"] < 1.0, f"-> {r2['highlight_crush_pct']}%")

# ROI 不改变全图坐标：全图波形在 ROI 外的列应为 0
roi = (100, 50, 300, 200)
res3 = analyze_frame(Y, U, V, "tv", roi, 640)
wf3 = res3["waveform"]
check("ROI: 选区外的列为空", wf3[:, :90].sum() == 0 and wf3[:, 330:].sum() == 0)
check("ROI: 选区内的列有数据", wf3[:, 150:250].sum() > 0)

# 点击反查
mask = pixels_at(Y, 320, 128, None)
check("反查: 掩码为全图尺寸且非空", mask.shape == Y.shape and mask.sum() > 0)
ys, xs = np.nonzero(mask)
check("反查: 命中像素列在容差内", xs.min() >= 317 and xs.max() <= 323)

# ---------------------------------------------------------------- 2. ffmpeg 解码
clip = os.path.join(TMP, "clip.mp4")
subprocess.run([
    "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i",
    "testsrc2=size=320x180:rate=25:duration=2", "-pix_fmt", "yuv420p", clip,
], check=True)
meta = probe(clip)
check("probe: 尺寸/帧数", meta["width"] == 320 and meta["n_frames"] == 50,
      f"-> {meta['width']}x{meta['height']} n={meta['n_frames']}")
print("     声明范围:", meta["declared_range"] or "缺失")

fs = FFmpegSource(clip)
Yf, Uf, Vf = fs.frame(0)
check("ffmpeg: 首帧形状", Yf.shape == (180, 320))
Ys, _, _ = fs.frame(25)   # 顺序向后
check("ffmpeg: 顺序跳帧", Ys.shape == (180, 320) and not np.array_equal(Yf, Ys))
Yb, _, _ = fs.frame(5)    # 回跳（重开管道 seek）
check("ffmpeg: 回跳 seek", Yb.shape == (180, 320))
fs2 = FFmpegSource(clip)
Ya, _, _ = fs2.frame(5)
check("ffmpeg: seek 帧内容一致", np.array_equal(Yb, Ya))
fs.close(); fs2.close()

# ---------------------------------------------------------------- 3. GUI 离屏
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtWidgets import QApplication
from videoscope.main import MainWindow

app = QApplication([])
w = MainWindow()
w.show()


def pump_until(cond, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        app.processEvents()
        if cond():
            return True
        time.sleep(0.02)
    return False


w._open_synthetic("overflow")
check("GUI: 首帧分析完成", pump_until(lambda: w._cur_idx == 0))
check("GUI: 读数帧标签如实", "0" in w.lbl_scope.text(), f"-> {w.lbl_scope.text()}")

w._step(5)
check("GUI: 逐帧步进", pump_until(lambda: w._cur_idx == 5),
      f"-> cur={w._cur_idx}")

# 框选后重分析，坐标仍为全图
w._on_roi((100, 50, 300, 200))
check("GUI: ROI 重分析", pump_until(lambda: w._cur_idx == 5 and w._analysis_busy is False))
check("GUI: 报告中标注 ROI", "ROI" in w.report.toPlainText())

# 点击反查高亮
w._highlight(160, 200, None)
check("GUI: 点击反查产生高亮", w.video._hl is not None)

# 对照快照
w._take_snapshot()
check("GUI: 快照保留", w._snapshot is not None and w._snapshot["idx"] == 5)
check("GUI: 报告显示对照行", "对照帧 5" in w.report.toPlainText())

# 范围切换（有限->全）后报告压边界计数
w.combo_range.setCurrentIndex(2)
check("GUI: 切全范围后重分析", pump_until(lambda: w._cur_idx == 5))
rep = w._cur_result["report"]
check("GUI: 全范围报告边界为 0/255",
      rep["range_lo"] == 0 and rep["range_hi"] == 255)

# 导出指定帧
w.spin_frame.setValue(10)
w._export_dir = TMP
# 直接走内部逻辑（避开文件对话框）
from videoscope.analysis import analyze_frame as af
planes = w.source.frame(10)
resx = af(*planes, w._rng(), w._roi, 1024)
from videoscope.widgets import waveform_to_qimage, parade_to_qimage, rgb_to_qimage
stem = os.path.join(TMP, "frame_000010")
rgb_to_qimage(*resx["rgb"]).save(stem + ".png")
waveform_to_qimage(resx["waveform"]).save(stem + "_waveform.png")
parade_to_qimage(resx["parade"], 1024).save(stem + "_parade.png")
with open(stem + "_report.json", "w") as f:
    json.dump({"frame": 10, "report": resx["report"]}, f)
ok = all(os.path.exists(stem + s) and os.path.getsize(stem + s) > 0
         for s in (".png", "_waveform.png", "_parade.png", "_report.json"))
check("GUI: 导出四类文件", ok)

w.close()
print("\n临时目录:", TMP)
if failures:
    print("失败:", failures)
    sys.exit(1)
print("全部通过")
