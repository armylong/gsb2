"""本地生成交错扫描样例, 同时保留逐行参考。

为什么不用普通逐行片加个交错标记:
  本模块先在 50fps 逐行时间轴上渲染真实运动 (水平移动的细竖线、上下方向
  箭头、计时文字), 再用 ffmpeg 的 tinterlace 把相邻两帧的两个场编织成一帧
  25fps 交错画面。每个交错帧确实包含两个不同时间的场, 可以核对:
    - 场序 (TFF/BFF 选错时运动边缘的时间方向相反);
    - 输出帧数 (单倍=N, 双倍=2N);
    - 实际运动位置 (细线在不同场时间处于不同 x 坐标)。

环境里的 ffmpeg 未编译 drawtext, 所以文字/图形全部用 PySide6 QPainter 渲染,
再以 rawvideo 管道喂给 ffmpeg, 不引入额外依赖。
"""
from __future__ import annotations

import argparse
import subprocess
from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import (
    QColor,
    QFont,
    QGuiApplication,
    QImage,
    QPainter,
    QPen,
    QPolygonF,
)

from .ffmpeg_tools import find_executable


@dataclass
class SampleSpec:
    width: int = 720
    height: int = 576
    field_rate: int = 50          # 逐行参考/场时间轴帧率
    duration: float = 4.0         # 秒
    line_speed_px_per_field: float = 6.0
    line_width: int = 3

    @property
    def n_fields(self) -> int:
        return round(self.field_rate * self.duration)

    @property
    def interlaced_fps(self) -> int:
        return self.field_rate // 2


def _line_x(spec: SampleSpec, field_index: int) -> float:
    span = spec.width - 80
    return 40 + (field_index * spec.line_speed_px_per_field) % span


def render_progressive_frame(spec: SampleSpec, field_index: int) -> QImage:
    """渲染逐行时间轴上的一帧 (一个场时间点)。"""
    img = QImage(spec.width, spec.height, QImage.Format.Format_RGB888)
    img.fill(QColor(18, 18, 24))
    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing, False)

    # 顶部/底部固定参考条, 用来确认场的空间归属。
    p.fillRect(0, 0, spec.width, 24, QColor(40, 40, 56))
    p.fillRect(0, spec.height - 24, spec.width, 24, QColor(40, 40, 56))

    # 上下方向标记: 偶数场画向上箭头 (青), 奇数场画向下箭头 (品红)。
    up = field_index % 2 == 0
    color = QColor(60, 220, 220) if up else QColor(220, 60, 200)
    p.setPen(QPen(color, 3))
    p.setBrush(color)
    cx, cy = spec.width - 90, spec.height // 2
    dy = -46 if up else 46
    arrow = QPolygonF([
        QPointF(cx, cy + dy),
        QPointF(cx - 26, cy + dy * 0.35),
        QPointF(cx - 10, cy + dy * 0.35),
        QPointF(cx - 10, cy - dy * 0.55),
        QPointF(cx + 10, cy - dy * 0.55),
        QPointF(cx + 10, cy + dy * 0.35),
        QPointF(cx + 26, cy + dy * 0.35),
    ])
    p.drawPolygon(arrow)

    # 水平移动的细竖线: 每个场时间点位置不同, 是核对运动/场序的主角。
    x = _line_x(spec, field_index)
    p.fillRect(int(round(x)), 40, spec.line_width, spec.height - 80,
               QColor(255, 220, 60))

    # 计时文字: 场时间、场号、输入帧号。
    p.setPen(QPen(QColor(235, 235, 235)))
    font = QFont("Menlo")
    font.setPointSize(20)
    p.setFont(font)
    t = field_index / spec.field_rate
    input_frame = field_index // 2
    p.drawText(
        16, 4, spec.width - 200, 40,
        Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
        f"t={t:0.3f}s  field={field_index:03d}  in_frame={input_frame + 1:03d}",
    )
    font2 = QFont("Menlo")
    font2.setPointSize(14)
    p.setFont(font2)
    p.setPen(QPen(QColor(170, 170, 180)))
    p.drawText(
        16, spec.height - 24, spec.width - 40, 24,
        Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
        ("UP field (top-field-first sample)" if up
         else "DOWN field (bottom-field-first sample)"),
    )
    p.end()
    return img


def _run_ffmpeg(cmd: list[str], stdin_data_proc=None) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg 失败:\n{' '.join(cmd)}\n{proc.stderr.strip()}"
        )


def generate_sample(out_dir: str | Path, spec: SampleSpec | None = None,
                    log=print) -> dict[str, Path]:
    """生成逐行参考与 TFF/BFF 两个交错样例, 返回路径字典。"""
    # QPainter 渲染需要一个 QGuiApplication 实例 (测试/GUI 已创建则复用)。
    if QGuiApplication.instance() is None:
        QGuiApplication([])
    spec = spec or SampleSpec()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    n = spec.n_fields
    rgb_path = out_dir / "_progressive_rgb.rgb"
    progressive_path = out_dir / "sample_progressive_ref.mp4"
    tff_path = out_dir / "sample_interlaced_tff.mp4"
    bff_path = out_dir / "sample_interlaced_bff.mp4"

    log(f"[1/4] 渲染 {n} 个场时间点的逐行帧 ({spec.width}x{spec.height} "
        f"@{spec.field_rate}fps) ...")
    with rgb_path.open("wb") as fh:
        for i in range(n):
            img = render_progressive_frame(spec, i)
            fh.write(bytes(img.bits()))

    ffmpeg = find_executable("ffmpeg")
    common_in = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{spec.width}x{spec.height}",
        "-framerate", str(spec.field_rate),
        "-i", str(rgb_path),
    ]

    # 逐行参考: 直接编码 50fps 逐行片。
    log("[2/4] 编码逐行参考 sample_progressive_ref.mp4 ...")
    _run_ffmpeg([
        *common_in,
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
        "-fps_mode", "passthrough", str(progressive_path),
    ])

    # 交错片: 编织相邻两场, 再用 fieldorder + ildct/ilme 写真实场标记。
    # 视频与正弦音在同一条 ffmpeg 里合成, 避免二次封装 -c:v copy 丢流级
    # field_order (那样逐帧标记还在, 但流标签会回退成 tt)。
    def interlace(interleave: str, order: str, dst: Path, tone: int) -> None:
        _run_ffmpeg([
            *common_in,
            "-f", "lavfi", "-i",
            f"sine=frequency={tone}:sample_rate=48000:duration={spec.duration}",
            "-filter_complex",
            f"[0:v]tinterlace={interleave},fieldorder={order},format=yuv420p[v]",
            "-map", "[v]", "-map", "1:a:0",
            "-c:v", "libx264", "-crf", "18",
            "-flags", "+ildct+ilme",
            "-c:a", "aac", "-b:a", "128k",
            "-fps_mode", "cfr", "-shortest", str(dst),
        ])

    log("[3/4] 编织 TFF 交错片 (含 1kHz 音频) ...")
    interlace("interleave_top", "tff", tff_path, 1000)
    log("[4/4] 编织 BFF 交错片 (含 1.2kHz 音频) ...")
    interlace("interleave_bottom", "bff", bff_path, 1200)

    rgb_path.unlink(missing_ok=True)
    return {
        "progressive": progressive_path,
        "tff": tff_path,
        "bff": bff_path,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="生成本地交错扫描样例")
    ap.add_argument("out_dir", help="输出目录")
    ap.add_argument("--duration", type=float, default=4.0)
    ap.add_argument("--width", type=int, default=720)
    ap.add_argument("--height", type=int, default=576)
    args = ap.parse_args()
    spec = SampleSpec(width=args.width, height=args.height, duration=args.duration)
    paths = generate_sample(args.out_dir, spec)
    print("生成完成:")
    for k, v in paths.items():
        print(f"  {k:12s} {v}")


if __name__ == "__main__":
    main()
