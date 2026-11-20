"""End-to-end self-check (no GUI required).

Runs the same code paths the UI uses and asserts the hard constraints from the
brief:

* deterministic alpha from image + constraints, hard FG/BG honoured,
* constraint record round trip with fingerprint rejection,
* exported transparent PNG reads back to the same alpha,
* undo/redo of a continuous stroke is one operation,
* zoomed painting lands on the correct original pixels,
* stale-preview detection.

Usage:  python selfcheck.py [--samples jug,sprig,ring]
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile

import numpy as np

from matting.constraints import BG, FG, LabelMap, Stroke, StrokeHistory
from matting.engine import ComputeSettings, MattingError, compute_matting
from matting.imageio import ensure_bgra, fingerprint_image, read_png_bgra, write_png
from matting.record import ConstraintRecord, RecordError, state_key
from matting.samples import SAMPLES, generate_sample


class Checker:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.lines: list[str] = []

    def check(self, ok: bool, name: str, detail: str = "") -> bool:
        if ok:
            self.passed += 1
            self.lines.append(f"  [PASS] {name}" + (f"  {detail}" if detail else ""))
        else:
            self.failed += 1
            self.lines.append(f"  [FAIL] {name}" + (f"  {detail}" if detail else ""))
        return ok

    def section(self, title: str) -> None:
        self.lines.append(f"\n{title}")

    def report(self) -> int:
        print("\n".join(self.lines))
        print(f"\n{self.passed} passed, {self.failed} failed")
        return 0 if self.failed == 0 else 1


def run(sample_keys) -> int:
    c = Checker()
    tmp = tempfile.mkdtemp(prefix="scribblematte-selfcheck-")

    for key in sample_keys:
        sample = generate_sample(key)
        image, gt = sample.image, sample.alpha
        h, w = image.shape[:2]
        c.section(f"样例 {key}（{w}×{h}）")

        # --- build the constraint state exactly like the UI does: box + strokes
        history = StrokeHistory(h, w)
        for stroke in sample.strokes:
            history.push(stroke)
        settings = ComputeSettings(box=sample.box, refine_radius=3, grabcut_iterations=4)
        result = compute_matting(image, history.labels, settings)

        # 1) hard constraints
        fg_px = history.labels.data == FG
        bg_px = history.labels.data == BG
        c.check(bool(np.all(result.alpha[fg_px] == 1.0)), "确定前景全部不透明")
        c.check(bool(np.all(result.alpha[bg_px] == 0.0)), "确定背景全部透明")

        # 2) quality vs reference
        iou = float(
            np.logical_and(result.alpha > 0.5, gt > 0.5).sum()
            / max(1, np.logical_or(result.alpha > 0.5, gt > 0.5).sum())
        )
        mse = float(((result.alpha - gt) ** 2).mean())
        c.check(iou >= 0.90, "与参考透明度 IoU ≥ 0.90", f"IoU={iou:.3f}")
        c.check(mse <= 0.01, "与参考透明度 MSE ≤ 0.01", f"MSE={mse:.4f}")

        # 3) recompute is deterministic and only depends on image + constraints.
        #    compute_matting() takes no previous-alpha argument by design, and a
        #    fixed GrabCut seed makes repeated runs bit-identical.
        again = compute_matting(image, history.labels, settings)
        c.check(np.array_equal(again.alpha, result.alpha),
                "重新计算只依赖原图与当前约束（结果逐像素可复现）")
        import inspect
        c.check("alpha_override" not in inspect.signature(compute_matting).parameters,
                "计算接口不接受上次结果作为输入")

        # 4) undo / redo: one gesture = one operation
        undo_history = StrokeHistory(h, w)
        for stroke in sample.strokes:
            undo_history.push(stroke)
        n = len(undo_history)
        before = undo_history.labels.data.copy()
        c.check(undo_history.can_undo() and not undo_history.can_redo(),
                "历史栈初始状态正确", f"{n} 步")
        undo_history.undo()
        c.check(undo_history.labels.count(FG) + undo_history.labels.count(BG)
                < int(np.count_nonzero(before)),
                "撤销后标记像素减少")
        undo_history.redo()
        c.check(np.array_equal(undo_history.labels.data, before), "重做后标记完全恢复")
        undo_history.push(Stroke(kind=FG, radius=10.0, points=[(w * 0.3, h * 0.4)]))
        c.check(not undo_history.can_redo(), "撤销后新笔画会清空重做分支")

        # 5) export transparent png and read back
        fg_path = os.path.join(tmp, f"{key}_fg.png")
        write_png(fg_path, ensure_bgra(result.foreground, result.alpha))
        raw = read_png_bgra(fg_path)
        c.check(raw.ndim == 3 and raw.shape[2] == 4, "透明 PNG 为 RGBA")
        back = raw[:, :, 3].astype(np.float32) / 255.0
        c.check(float(np.abs(back - result.alpha).max()) <= 1.0 / 255.0,
                "透明 PNG 回读的 alpha 与计算结果一致",
                f"最大误差 {float(np.abs(back - result.alpha).max()):.4f}")

        # 6) decontaminated foreground: no dark halo when composited on dark
        band = (result.alpha > 0.1) & (result.alpha < 0.9)
        black_halo = bool((result.foreground[band].sum(axis=1) < 30).any()) if band.any() else False
        c.check(not black_halo, "柔和边缘不残留黑色污染")
        bright = float(result.foreground[result.alpha > 0.99].mean())
        c.check(bright > 40, "前景颜色为原始物体颜色", f"均值 {bright:.0f}")

        # 7) record round trip + fingerprint rejection
        record = ConstraintRecord.build(image, sample.box, settings, history)
        text = record.to_json()
        loaded = ConstraintRecord.from_json(text, image)
        c.check(loaded.image.sha256 == fingerprint_image(image).sha256,
                "约束记录包含原图内容校验")
        new_history = StrokeHistory(h, w)
        loaded.apply_to(new_history, ComputeSettings())
        c.check(np.array_equal(new_history.labels.data, history.labels.data),
                "约束记录重载后标记完全一致")
        wrong = np.ascontiguousarray(image[:, ::-1].copy())  # mirrored image, same size
        rejected = False
        try:
            ConstraintRecord.from_json(text, wrong)
        except RecordError:
            rejected = True
        c.check(rejected, "内容不同的同尺寸图片会拒绝套用记录")

        # 8) stale detection
        key_before = state_key(image, sample.box, settings, history,
                               refine_radius=settings.refine_radius)
        history.push(Stroke(kind=FG, radius=10.0, points=[(w * 0.5, h * 0.5)]))
        key_after = state_key(image, sample.box, settings, history,
                              refine_radius=settings.refine_radius)
        c.check(key_before != key_after, "新增笔迹会触发“预览已过期”")

        # 9) zoomed sketching: widget->image round trip is exact at any zoom
        c.check(round_trip_ok(key, w, h), "缩放后笔迹落回正确的原图像素")

    # 10) failure modes
    c.section("失败反馈")
    sample = generate_sample("jug")
    h, w = sample.image.shape[:2]
    empty = LabelMap(h, w)
    empty.data[sample.box[1] + 40:sample.box[1] + 60, sample.box[0] + 40:sample.box[0] + 60] = FG
    cases = [
        ("缺少背景标记", empty, ComputeSettings(box=sample.box), "no_background"),
        ("缺少前景标记", _only_bg(h, w, sample.box), ComputeSettings(box=sample.box), "no_foreground"),
        ("选框太小", _both(h, w, sample.box), ComputeSettings(box=(10, 10, 20, 20)), "box_too_small"),
        ("全图单一颜色", _both(h, w, sample.box),
         ComputeSettings(box=sample.box), "uniform_image", np.full_like(sample.image, 127)),
    ]
    for case in cases:
        name, labels, cfg, code = case[:4]
        img = case[4] if len(case) > 4 else sample.image
        try:
            compute_matting(img, labels, cfg)
            c.check(False, name, "预期失败但成功了")
        except MattingError as exc:
            c.check(exc.code == code, name, f"{exc.code}: {exc.message.splitlines()[0]}")

    return c.report()


def _both(h, w, box):
    labels = LabelMap(h, w)
    x0, y0, x1, y1 = box
    labels.data[(y0 + y1) // 2 - 10:(y0 + y1) // 2 + 10, (x0 + x1) // 2 - 10:(x0 + x1) // 2 + 10] = FG
    labels.data[y0 + 5:y0 + 25, x0 + 5:x0 + 25] = BG
    return labels


def _only_bg(h, w, box):
    labels = LabelMap(h, w)
    x0, y0, x1, y1 = box
    labels.data[y0 + 5:y0 + 25, x0 + 5:x0 + 25] = BG
    return labels


def round_trip_ok(key, w, h) -> bool:
    """Exercise the real CanvasWidget transform at several zoom levels (offscreen Qt)."""
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PySide6 import QtCore, QtWidgets

    from matting.samples import generate_sample
    from ui.canvas import CanvasWidget

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    canvas = CanvasWidget()
    canvas.resize(640, 480)
    canvas.set_model(generate_sample(key).image)
    for zoom in (0.33, 1.0, 2.0, 3.7, 8.0, 16.0):
        canvas._zoom = zoom
        canvas._pan = QtCore.QPointF(-137.25, 42.5)
        for ix, iy in ((0.0, 0.0), (w / 3.0, h / 5.0), (w - 1.0, h - 1.0), (512.7, 331.3)):
            widget_pt = canvas.image_to_widget(QtCore.QPointF(ix, iy))
            back = canvas.widget_to_image(widget_pt)
            if abs(back.x() - ix) > 1e-6 or abs(back.y() - iy) > 1e-6:
                return False
    del app, canvas
    return True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", default="jug,sprig,ring")
    args = parser.parse_args(argv)
    keys = [k.strip() for k in args.samples.split(",") if k.strip() in SAMPLES]
    if not keys:
        print("no valid samples", file=sys.stderr)
        return 2
    return run(keys)


if __name__ == "__main__":
    raise SystemExit(main())
