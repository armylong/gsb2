"""生成无需外部素材的内置课程短片和配套 SRT。"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QFont, QLinearGradient, QPainter, QPen, QImage

from .media import ffmpeg_bin
from .model import Cue, Obstacle, Rect
from .srt import write_srt

SAMPLE_WIDTH = 1280
SAMPLE_HEIGHT = 720
SAMPLE_FPS = 24
SAMPLE_DURATION = 12.0


@dataclass(frozen=True)
class SampleAssets:
    video_path: Path
    srt_path: Path
    cues: list[Cue]
    obstacles: list[Obstacle]


def sample_cues() -> list[Cue]:
    rows = [
        (0.5, 2.8, "欢迎来到字幕避让功能演示。"),
        (3.1, 5.4, "右上角是整节课都在的题板，字幕会记住安全位置，不会无故来回跳。"),
        (5.7, 8.6, "右边这张图会在句子中间滑进来，所以整句字幕都要提前避开它可能出现的区域。"),
        (9.0, 11.6, "这时上下同时出现题板，常规候选位可能全部放不下。"),
    ]
    return [
        Cue(id=f"cue_{i}", index=i, start=a, end=b, text=text)
        for i, (a, b, text) in enumerate(rows, 1)
    ]


def sample_obstacles() -> list[Obstacle]:
    return [
        Obstacle(
            id="board_right_top",
            name="右上角固定题板",
            rect=Rect(900, 42, 340, 190),
            start=0.0,
            end=SAMPLE_DURATION,
            color="#ff4d4f",
        ),
        Obstacle(
            id="slide_in",
            name="中途滑入图片的扫过区",
            rect=Rect(858, 585, 422, 113),
            start=6.0,
            end=8.2,
            color="#fa8c16",
        ),
        Obstacle(
            id="panel_top",
            name="临时上方题板",
            rect=Rect(80, 64, 1120, 218),
            start=9.4,
            end=11.2,
            color="#eb2f96",
        ),
        Obstacle(
            id="panel_bottom",
            name="临时下方题板",
            rect=Rect(80, 448, 1120, 244),
            start=9.4,
            end=11.2,
            color="#722ed1",
        ),
    ]


def _font(size: int, bold: bool = False) -> QFont:
    f = QFont()
    f.setFamilies(["PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Heiti SC"])
    f.setPixelSize(size)
    f.setBold(bold)
    return f


def _draw_background(p: QPainter, t: float) -> None:
    grad = QLinearGradient(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
    grad.setColorAt(0, QColor("#eef4ff"))
    grad.setColorAt(1, QColor("#f8fafc"))
    p.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT, grad)

    p.fillRect(0, 0, SAMPLE_WIDTH, 72, QColor("#1d4ed8"))
    p.setPen(QColor("white"))
    p.setFont(_font(30, True))
    p.drawText(QRectF(42, 0, 700, 72), Qt.AlignmentFlag.AlignVCenter, "多媒体原理 · 字幕避让示例课")
    p.setFont(_font(20))
    p.drawText(QRectF(1080, 0, 160, 72), Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignRight, f"t={t:04.1f}s")

    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(QColor("#dbeafe"))
    p.drawRoundedRect(42, 105, 760, 390, 18, 18)
    p.setBrush(QColor("#1e3a8a"))
    p.setFont(_font(28, True))
    p.drawText(QRectF(72, 132, 650, 42), Qt.AlignmentFlag.AlignLeft, "课堂讲义")
    p.setBrush(QColor("#93c5fd"))
    for i, width in enumerate((620, 690, 560, 660, 480, 610)):
        y = 205 + i * 43
        p.drawRoundedRect(76, y, width, 18, 9, 9)

    p.setBrush(QColor("#bfdbfe"))
    p.drawRoundedRect(42, 525, 760, 150, 18, 18)
    p.setPen(QColor("#1e40af"))
    p.setFont(_font(24, True))
    p.drawText(QRectF(72, 548, 650, 36), Qt.AlignmentFlag.AlignLeft, "本节目标")
    p.setFont(_font(20))
    p.drawText(QRectF(72, 592, 690, 64), Qt.TextFlag.TextWordWrap, "根据题板出现时间和真实字幕字框，自动选择稳定、安全的画面位置。")


def _draw_board(p: QPainter) -> None:
    rect = QRectF(900, 42, 340, 190)
    p.setBrush(QColor(255, 255, 255, 245))
    pen = QPen(QColor("#ef4444"), 5)
    p.setPen(pen)
    p.drawRoundedRect(rect, 16, 16)
    p.setPen(QColor("#991b1b"))
    p.setFont(_font(25, True))
    p.drawText(QRectF(925, 58, 290, 38), Qt.AlignmentFlag.AlignLeft, "例题题板")
    p.setFont(_font(34, True))
    p.drawText(QRectF(930, 105, 285, 55), Qt.AlignmentFlag.AlignCenter, "A² + B² = C²")
    p.setFont(_font(20))
    p.drawText(QRectF(930, 164, 285, 42), Qt.AlignmentFlag.AlignCenter, "注意角上的遮挡区域")


def _ease(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def _draw_sliding_image(p: QPainter, t: float) -> None:
    # 6.0-6.8 从右侧滑入；7.6-8.2 向右滑出。
    if t < 6.0 or t >= 8.2:
        return
    if t < 6.8:
        progress = _ease((t - 6.0) / 0.8)
        x = SAMPLE_WIDTH + 20 - progress * (SAMPLE_WIDTH + 20 - 880)
    elif t < 7.6:
        x = 880.0
    else:
        progress = _ease((t - 7.6) / 0.6)
        x = 880 + progress * (SAMPLE_WIDTH + 20 - 880)
    rect = QRectF(x, 585, 360, 112)
    p.setBrush(QColor("#0ea5e9"))
    p.setPen(QPen(QColor("#075985"), 4))
    p.drawRoundedRect(rect, 18, 18)
    p.setPen(QColor("white"))
    p.setFont(_font(28, True))
    p.drawText(rect.adjusted(18, 18, -18, -18), Qt.AlignmentFlag.AlignCenter, "临时滑入图片\nSLIDE DIAGRAM")


def _draw_temporary_panels(p: QPainter, t: float) -> None:
    if not (9.4 <= t < 11.2):
        return
    alpha = 210 if 9.6 < t < 11.0 else 150
    for rect, title, color in (
        (QRectF(80, 64, 1120, 218), "临时上方题板：候选 top_* 全部不可用", QColor(190, 24, 93, alpha)),
        (QRectF(80, 448, 1120, 244), "临时下方题板：候选 bottom_* 全部不可用", QColor(76, 29, 149, alpha)),
    ):
        p.setBrush(color)
        p.setPen(QPen(QColor("white"), 5))
        p.drawRoundedRect(rect, 20, 20)
        p.setPen(QColor("white"))
        p.setFont(_font(34, True))
        p.drawText(rect, Qt.AlignmentFlag.AlignCenter, title)


def render_sample_frame(t: float) -> QImage:
    image = QImage(SAMPLE_WIDTH, SAMPLE_HEIGHT, QImage.Format.Format_RGBA8888)
    image.fill(QColor("white"))
    p = QPainter(image)
    try:
        _draw_background(p, t)
        _draw_board(p)
        _draw_sliding_image(p, t)
        _draw_temporary_panels(p, t)
    finally:
        p.end()
    return image


def generate_sample(out_dir: str | Path) -> SampleAssets:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    video_path = out / "builtin_lesson.mp4"
    srt_path = out / "builtin_lesson.srt"
    cues = sample_cues()
    write_srt(srt_path, cues)

    frame_count = int(round(SAMPLE_DURATION * SAMPLE_FPS))
    cmd = [
        ffmpeg_bin(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        f"{SAMPLE_WIDTH}x{SAMPLE_HEIGHT}",
        "-r",
        str(SAMPLE_FPS),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(video_path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    for i in range(frame_count):
        t = i / SAMPLE_FPS
        image = render_sample_frame(t)
        # PySide6 返回按 QImage 字节数定长的 memoryview，可直接作为缓冲区写入。
        proc.stdin.write(bytes(image.bits()))
    proc.stdin.close()
    stderr = proc.stderr.read().decode("utf-8", errors="replace")
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"生成内置短片失败: {stderr}")

    return SampleAssets(
        video_path=video_path,
        srt_path=srt_path,
        cues=cues,
        obstacles=sample_obstacles(),
    )
