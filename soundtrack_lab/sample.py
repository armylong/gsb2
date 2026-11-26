from __future__ import annotations

import base64
from pathlib import Path

import numpy as np
from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QPixmap

from .core import (
    AUDIO_RATE,
    ReadParams,
    add_defects,
    build_demo,
    calibration_summary,
    decode_image,
    encode_samples,
    metrics_rows,
    window_description,
    wav_bytes,
    write_wav,
)
from .qt_support import save_track_png


def _draw_waveform(p: QPainter, rect: QRect, samples: np.ndarray | None, color: QColor) -> None:
    p.save()
    p.setPen(QPen(QColor("#dddddd"), 1))
    mid = rect.center().y()
    p.drawLine(rect.left(), mid, rect.right(), mid)
    p.setPen(QPen(QColor("#f0f0f0"), 1))
    for i in range(1, 4):
        y = rect.top() + i * rect.height() / 4
        p.drawLine(rect.left(), int(y), rect.right(), int(y))

    if samples is not None and len(samples):
        npx = max(20, rect.width())
        chunk = max(1, len(samples) // npx)
        scale = rect.height() * 0.42
        p.setPen(QPen(color, 1.2))
        for i in range(npx):
            a = i * chunk
            b = len(samples) if i == npx - 1 else min(len(samples), a + chunk)
            if b <= a:
                continue
            part = samples[a:b]
            lo, hi = float(np.min(part)), float(np.max(part))
            x = rect.left() + i
            p.drawLine(x, int(mid - hi * scale), x, int(mid - lo * scale))
    p.setPen(QPen(QColor("#888"), 1))
    p.drawRect(rect)
    p.restore()


def _draw_strip(p: QPainter, rect: QRect, qimage, intervals=None, wide_rows: int | None = None,
                total_rows: int = 1) -> None:
    p.save()
    p.fillRect(rect, QColor("#eeeeea"))
    if qimage is not None:
        p.drawImage(rect, qimage)
    p.setPen(QPen(QColor("#222"), 1.5))
    p.drawRect(rect)

    if intervals:
        top = rect.top()
        h = rect.height()
        for d in intervals:
            top = rect.top()
            h = rect.height()
            ry0 = top + d.review_start_row / total_rows * h
            ry1 = top + d.review_end_row / total_rows * h
            cy0 = top + d.start_row / total_rows * h
            cy1 = top + d.end_row / total_rows * h
            p.fillRect(QRect(rect.left(), int(ry0), rect.width(), max(3, int(ry1 - ry0))), QColor(230, 170, 0, 80))
            p.fillRect(QRect(rect.left(), int(cy0), rect.width(), max(2, int(cy1 - cy0))), QColor(210, 45, 35, 100))
            p.setPen(QPen(QColor("#b3261e"), 1.5))
            p.drawRect(rect.left(), int(ry0), rect.width(), max(3, int(ry1 - ry0)))
    p.restore()


def render_comparison_sheet(
    path: Path,
    normal_qimage,
    broken_qimage,
    source: np.ndarray,
    normal_result,
    wide_result,
    broken_result,
    segments,
) -> None:
    from .qt_support import gray_to_qimage  # local avoids Qt plugin ordering concerns

    pix = QPixmap(1800, 1380)
    pix.fill(QColor("white"))
    p = QPainter(pix)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, True)

    title_font = QFont()
    title_font.setPointSize(24)
    title_font.setBold(True)
    p.setFont(title_font)
    p.setPen(QColor("#111"))
    p.drawText(QRect(30, 20, 1740, 42), Qt.AlignmentFlag.AlignCenter, "老胶片声轨：正常 / 过宽扫描窗 / 短断线 对照样例")

    body_font = QFont()
    body_font.setPointSize(12)
    p.setFont(body_font)
    p.drawText(QRect(40, 66, 1720, 42), Qt.TextFlag.TextWordWrap, calibration_summary(10.0))

    cols = [
        (40, "① 正常窄窗（1 行 = 0.125 ms）", QColor("#0b57d0"), normal_qimage, normal_result, None),
        (620, "② 过宽窗（31 行 = 1.55 mm = 3.875 ms）", QColor("#b36b00"), normal_qimage, wide_result, None),
        (1200, "③ 短断线（时间保留，边界黄色待查）", QColor("#b3261e"), broken_qimage, broken_result, broken_result.defects),
    ]
    top_y = 120
    strip_rect = QRect(70, top_y + 42, 150, 560)
    wave_rect = QRect(245, top_y + 42, 300, 560)

    for x, title, color, image, result, intervals in cols:
        p.setPen(color)
        f = QFont()
        f.setPointSize(15)
        f.setBold(True)
        p.setFont(f)
        p.drawText(QRect(x, top_y, 540, 30), Qt.AlignmentFlag.AlignLeft, title)
        sr = QRect(strip_rect)
        sr.moveLeft(x + 30)
        wr = QRect(wave_rect)
        wr.moveLeft(x + 205)
        _draw_strip(p, sr, image, intervals, total_rows=max(1, len(result.samples_row)))
        _draw_waveform(p, wr, result.samples_audio, color)
        p.setPen(QColor("#333"))
        p.setFont(body_font)
        text = (
            f"时长 {result.duration:.2f} s\n"
            f"DC 偏移 {result.dc_offset:+.2f} px\n"
            f"提示：{('；'.join(result.messages) if result.messages else '边缘跟踪正常')}"
        )
        p.drawText(QRect(x + 20, top_y + 615, 520, 70), Qt.TextFlag.TextWordWrap, text)

    # Bottom source waveform.
    p.setPen(QColor("#1b5e20"))
    f = QFont(); f.setPointSize(14); f.setBold(True); p.setFont(f)
    p.drawText(40, 825, "源音时间标尺（三段已知信号 + 静音底 + 脉冲）")
    source_rect = QRect(70, 840, 1660, 150)
    _draw_waveform(p, source_rect, source, QColor("#1b5e20"))
    for seg in segments:
        xa = 70 + int(seg.start / 3.2 * 1660)
        xb = 70 + int(seg.end / 3.2 * 1660)
        p.setPen(QPen(QColor(27, 94, 32, 120), 1, Qt.PenStyle.DashLine))
        p.drawLine(xa, 840, xa, 990)
        p.setPen(QColor("#1b5e20"))
        p.drawText(QRect(xa + 4, 994, max(80, xb - xa), 34), Qt.TextFlag.TextWordWrap,
                   f"{seg.label}\n{seg.start:.2f}-{seg.end:.2f}s")

    # Metrics table.
    rows = metrics_rows(source, normal_result, wide_result, segments)
    table_y = 1065
    p.setPen(QColor("#111"))
    f = QFont(); f.setPointSize(14); f.setBold(True); p.setFont(f)
    p.drawText(40, table_y, "恢复电平 / 静音底 / 脉冲比较")
    f.setPointSize(11); f.setBold(False); p.setFont(f)
    y = table_y + 28
    headers = ["指标", "源音", "正常", "过宽"]
    xs = [50, 520, 850, 1180]
    for x, h in zip(xs, headers):
        p.drawText(x, y, h)
    y += 10
    p.setPen(QPen(QColor("#999"), 1))
    p.drawLine(40, y, 1760, y)
    y += 24
    p.setPen(QColor("#222"))
    for row in rows:
        vals = [
            row["metric"],
            row["source"],
            f"{row['baseline']} {row['baseline_ratio']}",
            f"{row['trial']} {row['trial_ratio']}",
        ]
        for x, val in zip(xs, vals):
            p.drawText(QRect(x, y - 16, 310, 34), Qt.TextFlag.TextWordWrap, str(val))
        y += 42

    p.end()
    pix.save(str(path), "PNG")


def generate_bundle(outdir: str | Path = "examples/sample_bundle") -> Path:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)

    source, segments = build_demo()
    track = encode_samples(source, segments)
    normal_gray = track.gray
    broken_gray, _planned = add_defects(normal_gray, "break")
    dirty_gray, _ = add_defects(normal_gray, "dirty")

    normal = decode_image(normal_gray, ReadParams(window_rows=1), track.meta)
    wide = decode_image(normal_gray, ReadParams(window_rows=31), track.meta)
    broken = decode_image(broken_gray, ReadParams(window_rows=3), track.meta)

    normal_meta = dict(track.meta)
    normal_meta["source_wav_b64"] = base64.b64encode(wav_bytes(source)).decode("ascii")
    broken_meta = dict(normal_meta)
    broken_meta["sample_note"] = "short line break example; review intervals preserve elapsed time"

    write_wav(out / "sample_source.wav", source, AUDIO_RATE)
    write_wav(out / "readback_normal.wav", normal.samples_audio, AUDIO_RATE)
    write_wav(out / "readback_too_wide.wav", wide.samples_audio, AUDIO_RATE)
    write_wav(out / "readback_short_break.wav", broken.samples_audio, AUDIO_RATE)

    save_track_png(out / "soundtrack_normal.png", normal_gray, normal_meta)
    save_track_png(out / "soundtrack_short_break.png", broken_gray, broken_meta)
    save_track_png(out / "soundtrack_dirty_example.png", dirty_gray, broken_meta)

    from .qt_support import gray_to_qimage

    render_comparison_sheet(
        out / "comparison.png",
        gray_to_qimage(normal_gray),
        gray_to_qimage(broken_gray),
        source,
        normal,
        wide,
        broken,
        segments,
    )

    metrics = metrics_rows(source, normal, wide, segments)
    md = [
        "# 可重新生成的图声对照样例",
        "",
        "重新生成：",
        "",
        "```bash",
        ".venv/bin/python generate_sample.py",
        "```",
        "",
        calibration_summary(10.0),
        "",
        f"- 正常窗：{window_description(1)}",
        f"- 过宽窗：{window_description(31)}",
        f"- 短断线回读使用：{window_description(3)}",
        "",
        "## 文件",
        "",
        "- `comparison.png`：正常、过宽、短断线总对照图",
        "- `soundtrack_normal.png` / `soundtrack_short_break.png`：可在应用中用“重开导出的 PNG”回读",
        "- `sample_source.wav`：源音",
        "- `readback_normal.wav` / `readback_too_wide.wav` / `readback_short_break.wav`：三种回读",
        "",
        "## 指标",
        "",
        "| 指标 | 源音 | 正常 | 过宽 |",
        "|---|---:|---:|---:|",
    ]
    for r in metrics:
        md.append(
            f"| {r['metric']} | {r['source']} | {r['baseline']} {r['baseline_ratio']} | "
            f"{r['trial']} {r['trial_ratio']} |"
        )
    md += [
        "",
        "短断线检测区间：",
        "",
    ]
    for d in broken.defects:
        md.append(
            f"- `{d.status}` {d.kind}: {d.start_time:.3f}–{d.end_time:.3f} s，"
            f"保留待查时间 {d.duration * 1000:.1f} ms；{d.reason}"
        )
    (out / "README_sample.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    return out


def main() -> int:
    import sys

    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication(sys.argv)  # noqa: F841
    out = generate_bundle()
    print(f"sample bundle written: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
