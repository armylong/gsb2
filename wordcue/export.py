"""导出: 边界审计、SRT、带高亮的短视频、可重开的项目包。"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import Callable

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QFont, QFontMetricsF, QImage, QPainter
from .model import Cue, Timeline, format_ms, ms_to_srt


class ExportError(RuntimeError):
    pass


# ------------------------------------------------------------------ 边界审计
@dataclass
class BoundaryRow:
    prev: Cue | None
    nxt: Cue | None
    gap_ms: int
    status: str      # "ok" | "tight" | "overlap" | "unmarked"
    detail: str


def boundary_report(timeline: Timeline, tight_ms: int = 15) -> list[BoundaryRow]:
    """按阅读顺序逐对检查相邻两词的边界。

    这是导出前最后一道检查, 也是用户在「边界报告」面板里看到的内容:
    * overlap: 后一词早于前一词结束 (视频里会同时高亮);
    * tight: 间隔 < tight_ms, 人耳几乎听不出分界, 高亮会像跳字;
    * unmarked: 有词还没打轴;
    * ok: 其余。
    """
    cues = timeline.ordered_cues()
    rows: list[BoundaryRow] = []
    for prev, nxt in zip(cues, cues[1:]):
        if not prev.is_timed or not nxt.is_timed:
            rows.append(BoundaryRow(prev, nxt, nxt.start - prev.end, "unmarked",
                                    "有词尚未打轴"))
            continue
        gap = nxt.start - prev.end
        if gap < 0:
            rows.append(BoundaryRow(prev, nxt, gap, "overlap",
                                    f"重叠 {-gap} ms: 两个字会同时高亮"))
        elif gap == 0:
            rows.append(BoundaryRow(prev, nxt, gap, "ok", "紧贴, 边界清晰"))
        elif gap < tight_ms:
            rows.append(BoundaryRow(prev, nxt, gap, "tight",
                                    f"仅隔 {gap} ms, 这段静音短到听不出来, 建议归零或加长"))
        elif gap > 800:
            rows.append(BoundaryRow(prev, nxt, gap, "tight",
                                    f"间隔 {gap} ms 偏长, 确认这里没有漏掉的停顿"))
        else:
            rows.append(BoundaryRow(prev, nxt, gap, "ok", f"间隔 {gap} ms"))
    return rows


def blocking_issues(timeline: Timeline) -> list[str]:
    return [issue.message for issue in timeline.conflicts() if issue.level == "error"]


# ------------------------------------------------------------------ 文本排版
@dataclass
class Glyph:
    char: str
    cue_id: int
    x: float
    line: int


@dataclass
class TextLayout:
    glyphs: list[Glyph]
    line_count: int
    font_size: int
    line_height: float
    width: float
    top: float


def layout_text(timeline: Timeline, width: float, max_font: int = 92,
                min_font: int = 38, max_lines: int = 7,
                margin: float = 40.0) -> TextLayout:
    """把整段文本按字符排成若干行, 记录每个字属于哪个 cue 及其 x 坐标。"""
    font = QFont()
    font.setFamilies(["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
                      "Microsoft YaHei", "Arial Unicode MS"])
    font.setWeight(QFont.Weight.DemiBold)
    cues = timeline.ordered_cues()
    chars: list[tuple[str, int]] = []
    for cue in cues:
        for ch in cue.text:
            chars.append((ch, cue.id))
    if not chars:
        return TextLayout([], 0, max_font, max_font * 1.35, width, 0.0)

    usable = width - margin * 2
    for size in range(max_font, min_font - 1, -2):
        font.setPixelSize(size)
        fm = QFontMetricsF(font)
        line_height = fm.height() * 1.28
        glyphs: list[Glyph] = []
        line = 0
        x = margin
        for ch, cue_id in chars:
            if ch == "\n":
                line += 1
                x = margin
                continue
            adv = fm.horizontalAdvance(ch)
            if x + adv > margin + usable and x > margin:
                line += 1
                x = margin
            glyphs.append(Glyph(ch, cue_id, x, line))
            x += adv
        if line + 1 <= max_lines:
            return TextLayout(glyphs, line + 1, size, line_height, width, 0.0)
    # 实在放不下: 用最小字号, 允许超出 max_lines
    font.setPixelSize(min_font)
    fm = QFontMetricsF(font)
    line_height = fm.height() * 1.28
    glyphs = []
    line = 0
    x = margin
    for ch, cue_id in chars:
        if ch == "\n":
            line += 1
            x = margin
            continue
        adv = fm.horizontalAdvance(ch)
        if x + adv > margin + usable and x > margin:
            line += 1
            x = margin
        glyphs.append(Glyph(ch, cue_id, x, line))
        x += adv
    return TextLayout(glyphs, line + 1, min_font, line_height, width, 0.0)


# ------------------------------------------------------------------ 视频渲染
BG = QColor("#0D1015")
TEXT_IDLE = QColor("#7C8798")
TEXT_NEAR = QColor("#C3CAD6")
ACCENT = QColor("#F5B942")
ACCENT_SOFT = QColor("#7A5A20")
TEXT_ON_ACCENT = QColor("#14181F")
MUTED = QColor("#5B6574")
DIM = QColor("#242B35")


class FrameRenderer:
    """逐帧绘制竖屏短视频的画面."""

    HOLD_GAP_MS = 300

    def __init__(self, timeline: Timeline, width: int = 1080, height: int = 1920,
                 title: str = "") -> None:
        self.timeline = timeline
        self.width = width
        self.height = height
        self.title = title or timeline.title or "朗读"
        self.font = QFont()
        self.font.setFamilies(["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
                               "Microsoft YaHei", "Arial Unicode MS"])
        self.font.setWeight(QFont.Weight.DemiBold)
        outer_margin = width * 0.10
        self.layout = layout_text(timeline, width, max_font=max(48, int(width * 0.098)),
                                  min_font=max(26, int(width * 0.042)),
                                  max_lines=7, margin=outer_margin)
        self.text_top = height * 0.46 - (self.layout.line_count * self.layout.line_height) / 2
        self.cues = timeline.ordered_cues()
        self.by_id = {c.id: c for c in self.cues}

    def active_cue_id(self, t_ms: int) -> int | None:
        """按阅读顺序找当前应高亮的词.

        * 落在词内 → 该词;
        * 落在停顿内 → 熄灭 (停顿不该有「正在读的字」);
        * 落在词间空隙 → 刚结束的词最多延续 ``HOLD_GAP_MS``, 再长就熄灭。
        """
        last: Cue | None = None
        for cue in self.cues:
            if not cue.is_timed:
                continue
            if cue.start <= t_ms < cue.end:
                return None if cue.kind == "pause" else cue.id
            if cue.end <= t_ms:
                last = cue
            if cue.start > t_ms:
                break
        if last is not None and last.kind != "pause" and t_ms - last.end <= self.HOLD_GAP_MS:
            return last.id
        return None

    def render(self, t_ms: int) -> QImage:
        img = QImage(self.width, self.height, QImage.Format.Format_RGB32)
        img.fill(BG)
        p = QPainter(img)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        try:
            self._draw_header(p)
            self._draw_text(p, t_ms)
            self._draw_footer(p, t_ms)
        finally:
            p.end()
        return img

    # ------------------------------------------------------------------ 内部
    def _draw_header(self, p: QPainter) -> None:
        w, h = self.width, self.height
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#151A22"))
        p.drawRoundedRect(QRectF(w * 0.08, h * 0.055, w * 0.84, 4), 2, 2)
        # 顶部细进度条由 _draw_footer 的当前时间驱动; 这里只画标题。
        f = QFont(self.font)
        f.setPixelSize(max(20, int(w * 0.026)))
        f.setWeight(QFont.Weight.Normal)
        p.setFont(f)
        p.setPen(MUTED)
        p.drawText(QRectF(w * 0.08, h * 0.075, w * 0.84, 50),
                   Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   self.title)

    def _draw_text(self, p: QPainter, t_ms: int) -> None:
        """逐字高亮: 当前词用强调色 + 逐字填充的下划线, 已读词保持较亮."""
        lay = self.layout
        if not lay.glyphs:
            return
        f = QFont(self.font)
        f.setPixelSize(lay.font_size)
        p.setFont(f)
        active_id = self.active_cue_id(t_ms)
        active = self.by_id.get(active_id) if active_id is not None else None
        order = {c.id: i for i, c in enumerate(self.cues)}
        cursor = order.get(active.id) if active is not None else self._reading_cursor(t_ms)
        progress = 0.0
        if active and active.is_timed:
            progress = max(0.0, min(1.0, (t_ms - active.start) / max(1, active.duration)))

        for g in lay.glyphs:
            y = self.text_top + g.line * lay.line_height
            idx = order.get(g.cue_id, 0)
            if active is not None and g.cue_id == active.id:
                color = ACCENT
            elif idx < cursor:
                color = TEXT_NEAR
            else:
                color = TEXT_IDLE
            p.setPen(color)
            p.drawText(QRectF(g.x, y, lay.font_size * 2, lay.line_height),
                       Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, g.char)
        if active is None:
            return
        active_glyphs = [g for g in lay.glyphs if g.cue_id == active.id]
        if not active_glyphs:
            return
        covered = progress * len(active_glyphs)
        size = lay.font_size
        for index, g in enumerate(active_glyphs):
            y = self.text_top + g.line * lay.line_height
            baseline = y + lay.line_height * 0.5 + size * 0.58
            left = g.x + size * 0.02
            width = size * 0.82
            height = max(2.0, size * 0.075)
            fill = max(0.0, min(1.0, covered - index))
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor("#4A422F"))
            p.drawRoundedRect(QRectF(left, baseline, width, height), height / 2, height / 2)
            if fill > 0:
                p.setBrush(ACCENT)
                p.drawRoundedRect(QRectF(left, baseline, width * fill, height),
                                  height / 2, height / 2)

    def _reading_cursor(self, t_ms: int) -> int:
        """没有正在高亮的词时, 返回「已读完」的词数, 用于着色已读/未读."""
        count = 0
        for cue in self.cues:
            if cue.is_timed and cue.end <= t_ms:
                count += 1
            elif cue.is_timed and cue.start > t_ms:
                break
            elif not cue.is_timed:
                count += 1
        return count

    def _draw_footer(self, p: QPainter, t_ms: int) -> None:
        w, h = self.width, self.height
        total = max(1, self.timeline.duration)
        ratio = max(0.0, min(1.0, t_ms / total))
        bar_y = h * 0.90
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(DIM)
        p.drawRoundedRect(QRectF(w * 0.08, bar_y, w * 0.84, 8), 4, 4)
        p.setBrush(ACCENT)
        p.drawRoundedRect(QRectF(w * 0.08, bar_y, w * 0.84 * ratio, 8), 4, 4)
        # 进度条上的词刻度
        p.setBrush(QColor("#3A4352"))
        for cue in self.cues:
            if not cue.is_timed:
                continue
            x = w * 0.08 + w * 0.84 * cue.start / total
            p.drawRect(QRectF(x, bar_y - 5, 2, 18))
        f = QFont(self.font)
        f.setPixelSize(max(22, int(w * 0.030)))
        f.setWeight(QFont.Weight.Normal)
        p.setFont(f)
        p.setPen(MUTED)
        p.drawText(QRectF(w * 0.08, bar_y + 26, w * 0.6, 50),
                   Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   f"{format_ms(t_ms)} / {format_ms(total)}")
        active = self.active_cue_id(t_ms)
        if active is not None:
            idx = self.cues.index(self.by_id[active]) + 1 if active in self.by_id else 0
            p.drawText(QRectF(w * 0.32, bar_y + 26, w * 0.6, 50),
                       Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                       f"{idx} / {len(self.cues)}")
        # 品牌小字
        f.setPixelSize(max(18, int(w * 0.020)))
        p.setFont(f)
        p.setPen(QColor("#3C4554"))
        p.drawText(QRectF(w * 0.08, h * 0.955, w * 0.84, 40),
                   Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, "wordcue")


# ------------------------------------------------------------------ 导出操作
def check_ffmpeg() -> None:
    if not shutil.which("ffmpeg"):
        raise ExportError("找不到 ffmpeg; 视频导出需要 FFmpeg (macOS: brew install ffmpeg)")


def export_srt(timeline: Timeline, path: str, join_gap_ms: int = 150) -> int:
    """按阅读顺序输出 SRT; 返回条数.

    * 相邻词之间间隔不超过 ``join_gap_ms`` 时并入同一条 (逐词字幕闪得太快);
    * 停顿不单独出字幕, 它体现为两条字幕之间的时间空隙, 也是天然的断句点;
    * 重叠的相邻词不会被合并, 保留用户标注的原样, 便于在播放器里就能看出问题。
    """
    groups: list[list] = []
    for cue in timeline.ordered_cues():
        if not cue.is_timed or cue.kind == "pause":
            continue
        if groups:
            last = groups[-1][-1]
            if cue.start - last.end <= join_gap_ms:
                groups[-1].append(cue)
                continue
        groups.append([cue])
    lines = []
    for index, group in enumerate(groups, 1):
        start = min(c.start for c in group)
        end = max(c.end for c in group)
        text = "".join(c.text for c in group)
        lines.append(f"{index}\n{ms_to_srt(start)} --> {ms_to_srt(end)}\n{text}\n")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    return len(lines)


def export_bundle(timeline: Timeline, project_path: str, audio_source: str | None = None) -> str:
    """把时间轴 JSON 与音频复制到同一目录, audio_path 存相对路径, 可整体搬移后重开。"""
    folder = os.path.dirname(os.path.abspath(project_path))
    os.makedirs(folder, exist_ok=True)
    source = audio_source or timeline.audio_path
    audio_name = os.path.basename(timeline.audio_path) if timeline.audio_path else "audio.wav"
    target_audio = os.path.join(folder, audio_name)
    if source and os.path.exists(source) and os.path.abspath(source) != os.path.abspath(target_audio):
        shutil.copyfile(source, target_audio)
    saved = timeline.clone()
    saved.audio_path = audio_name if source else ""
    saved.save(project_path)
    return project_path


def export_video(timeline: Timeline, audio_path: str, out_path: str, *,
                 fps: int = 25, width: int = 1080, height: int = 1920,
                 title: str = "",
                 progress: Callable[[float, str], bool] | None = None) -> str:
    """用 ffmpeg 把逐帧渲染结果与音频合成 mp4.

    ``progress(fraction, message)`` 返回 False 可中止导出。
    """
    check_ffmpeg()
    if not audio_path or not os.path.exists(audio_path):
        raise ExportError("音频文件不存在, 无法导出")
    from PySide6.QtWidgets import QApplication

    if QApplication.instance() is None:
        raise ExportError("视频渲染需要先创建 Qt 应用 (请从界面导出, 或先构造 QApplication)")
    duration_ms = max(timeline.duration, 1)
    total_frames = max(1, int(round(duration_ms / 1000 * fps)))
    renderer = FrameRenderer(timeline, width, height, title)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb32", "-s", f"{width}x{height}",
        "-framerate", str(fps), "-i", "-",
        "-i", audio_path,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-tune", "animation",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest", "-movflags", "+faststart", out_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    assert proc.stdin is not None
    cancelled = False
    try:
        for frame_index in range(total_frames):
            t_ms = int(frame_index * 1000 / fps)
            image = renderer.render(t_ms)
            proc.stdin.write(image.constBits().tobytes())
            if progress and frame_index % max(1, total_frames // 100) == 0:
                if not progress(frame_index / total_frames, f"渲染第 {frame_index}/{total_frames} 帧"):
                    cancelled = True
                    break
        progress and progress(1.0 if not cancelled else 0.0,
                              "正在收尾 (封装音频/视频)…")
        proc.stdin.close()
        stderr = proc.stderr.read() if proc.stderr else b""
        code = proc.wait()
    except BrokenPipeError:
        stderr = b""
        code = proc.wait()
    except BaseException:
        proc.kill()
        raise
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    if cancelled:
        _remove_quietly(out_path)
        raise ExportError("导出已取消")
    if code != 0:
        _remove_quietly(out_path)
        detail = stderr.decode("utf-8", "replace").strip().splitlines()
        raise ExportError("ffmpeg 导出失败: " + (" / ".join(detail[-3:]) or f"退出码 {code}"))
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise ExportError("ffmpeg 没有生成输出文件")
    progress and progress(1.0, "完成")
    return out_path


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
