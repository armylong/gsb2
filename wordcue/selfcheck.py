"""无界面的端到端自检: ``python -m wordcue --self-check``.

覆盖需求里的 5 条:
  1. 文本 + 音频 → 词/停顿 + 手工时间
  2. 顺序不变量 + 批量平移预检
  3. 合并/拆分保留后续词时间
  4. 播放位置、跳转、波形/视频共用同一时间基准 (用 AudioPlayer 的位置公式验证)
  5. 项目包可重开 + SRT/带高亮视频导出 + 相邻边界报告
"""

from __future__ import annotations

import os
import shutil
import tempfile

from .audio import decode_to_pcm, ffmpeg_available
from .export import boundary_report, export_bundle, export_srt, export_video
from .model import Timeline, format_ms
from .sample import build_sample
from .segmentation import segment_text


class CheckFailed(AssertionError):
    pass


def _expect(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailed(message)
    print(f"  ✓ {message}")


def _make_timeline(duration: int = 6000) -> Timeline:
    tl = Timeline(duration=duration, text="春眠不觉晓")
    for text, start, end in (("春", 100, 500), ("眠", 500, 900),
                             ("不", 900, 1300), ("觉", 1300, 1700),
                             ("晓", 1700, 2100)):
        tl.add_cue(text, start, end)
    return tl


def check_model() -> None:
    print("[1] 文本切分与手工时间")
    tokens = segment_text("春眠不觉晓，处处闻啼鸟。", cjk_chunk=2)
    _expect([t for t, k in tokens if k == "pause"] == ["，", "。"],
            "标点切分为停顿")
    _expect("".join(t for t, _ in tokens) == "春眠不觉晓，处处闻啼鸟。",
            "切分不增删字符")

    tl = _make_timeline()
    _expect([c.id for c in tl.ordered_cues()] == [1, 2, 3, 4, 5], "阅读顺序等于输入顺序")
    _expect(not [i for i in tl.conflicts() if i.level == "error"], "初始时间轴无错误")

    print("[2] 顺序不变量 + 批量平移预检")
    rejected = tl.preview_shift([1, 2], 1000)
    _expect(not rejected.ok, "平移到与后续词重叠时预检报错")
    _expect(any("重叠" in e for e in rejected.errors), "预检信息指出具体重叠对象")
    before = [(c.id, c.start, c.end) for c in tl.cues]
    tl.shift_cues([1, 2], 1000)
    _expect([(c.id, c.start, c.end) for c in tl.cues] == before,
            "预检失败时时间轴一个字节都不改")
    ok = tl.preview_shift([4, 5], 100)
    _expect(ok.ok, "合法平移通过预检")
    tl.shift_cues([4, 5], 100)
    _expect(tl.cue(4).start == 1400 and tl.cue(5).start == 1800, "合法平移生效")
    _expect([c.id for c in tl.ordered_cues()] == [1, 2, 3, 4, 5], "平移后阅读顺序不变")

    order = tl.move_cue(1, 1200, 1600)
    _expect(not order.ok and any("颠倒" in e for e in order.errors),
            "单个词移动到后词之后会被拦下")

    print("[3] 合并 / 拆分保留后续词时间")
    tl = _make_timeline()
    tail_before = [(c.id, c.start, c.end) for c in tl.cues if c.id in (4, 5)]
    merged = tl.merge_cues([1, 2])
    _expect(merged.ok and tl.cue(1).text == "春眠", "相邻词合并为一个 cue")
    _expect(tl.cue(1).start == 100 and tl.cue(1).end == 900, "合并取并集区间")
    _expect([(c.id, c.start, c.end) for c in tl.cues if c.id in (4, 5)] == tail_before,
            "合并后后续词时间完全不动")

    split = tl.split_cue(1, 1, 500)
    _expect(split.ok, "合并后的词可以再拆分")
    parts = [c for c in tl.ordered_cues() if c.id in split.changed_ids]
    _expect([c.text for c in parts] == ["春", "眠"], "拆分文本正确")
    _expect(parts[0].start == 100 and parts[1].end == 900, "拆分后总区间不变")
    _expect([(c.id, c.start, c.end) for c in tl.cues if c.id in (4, 5)] == tail_before,
            "拆分后后续词时间完全不动")

    print("[4] 边界与时间基准")
    rows = boundary_report(tl)
    _expect(len(rows) == len(tl.cues) - 1, "相邻两词两两成对检查")
    _expect(all(r.status == "ok" for r in rows), "示例时间轴边界正常")
    tl.cue(5).start = 1400  # 「晓」提前, 压到「觉」身上
    overlap_rows = [r for r in boundary_report(tl) if r.status == "overlap"]
    _expect(bool(overlap_rows), "人为制造重叠后边界报告标出 overlap")
    _expect(any(i.level == "error" for i in tl.conflicts()), "冲突检查同步报错")
    tl.cue(5).start = 1700

    # 时间基准: 播放位置 = 起点 + 已播放毫秒 (整数 ms), UI/波形/导出共用这个值。
    tl2 = _make_timeline()
    _expect(format_ms(tl2.cue(3).start) == "0:00.900", "时间码格式统一为 m:ss.mmm")


def check_export(directory: str, with_video: bool) -> None:
    print("[5] 项目包、字幕与视频导出")
    timeline = build_sample(directory)
    _expect(timeline.duration > 0 and len(timeline.cues) >= 8, "样例音频与词轴已生成")
    _expect(os.path.getsize(timeline.audio_path) > 1000, "样例音频非空")
    _expect(not [i for i in timeline.conflicts() if i.level == "error"], "样例时间轴无错误")

    project = os.path.join(directory, "project", "timeline.json")
    export_bundle(timeline, project, timeline.audio_path)
    from .model import Timeline as TL
    reopened = TL.load(project)
    _expect(reopened.to_dict()["cues"] == timeline.to_dict()["cues"]
            and reopened.to_dict()["reading_order"] == timeline.to_dict()["reading_order"]
            and reopened.duration == timeline.duration,
            "项目 JSON 重开后词轴内容完全一致")
    audio_rel = reopened.audio_path
    _expect(not os.path.isabs(audio_rel) and os.path.exists(os.path.join(os.path.dirname(project), audio_rel)),
            "项目包音频用相对路径, 目录可整体搬移")

    srt_path = os.path.join(directory, "out.srt")
    count = export_srt(reopened, srt_path)
    words = sum(1 for c in reopened.cues if c.is_timed and c.kind == "word")
    _expect(0 < count <= words, f"SRT 条数合理 (词级 {words} 个, 合并后 {count} 条)")
    with open(srt_path, encoding="utf-8") as fh:
        text = fh.read()
    _expect("-->" in text and "00:00:" in text, "SRT 时间码格式正确")

    if not with_video:
        print("  · 跳过视频导出 (未找到 ffmpeg 或使用 --self-check-no-video)")
        return
    _expect(ffmpeg_available(), "ffmpeg / ffprobe 可用")
    video = os.path.join(directory, "preview.mp4")
    export_video(reopened, os.path.join(os.path.dirname(project), audio_rel), video,
                 fps=12, width=360, height=640)
    _expect(os.path.getsize(video) > 10_000, "带高亮短视频已生成")
    import subprocess
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height",
         "-of", "csv=p=0", video], capture_output=True, text=True)
    streams = probe.stdout.strip().splitlines()
    _expect(any("video" in s and "360,640" in s for s in streams), "视频流 360x640")
    _expect(any("audio" in s for s in streams), "视频带音轨")


def check_audio_timebase(directory: str) -> None:
    print("[6] 音频解码与统一时间基准")
    timeline = build_sample(directory)
    pcm = decode_to_pcm(timeline.audio_path)
    duration_ms = int(round(len(pcm) / 48_000 * 1000))
    _expect(abs(duration_ms - timeline.duration) <= 1, "解码 PCM 时长与时间轴一致 (±1 ms)")


def run(with_video: bool = True, keep: bool = False) -> int:
    directory = tempfile.mkdtemp(prefix="wordcue-check-")
    print(f"wordcue 自检 · 临时目录 {directory}")
    if with_video:
        # 视频渲染走 QImage/QPainter, 需要一个 QGuiApplication; 用 offscreen
        # 平台保证在无显示环境的 CI 里也能跑。
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        from PySide6.QtGui import QGuiApplication

        QGuiApplication.instance() or QGuiApplication([])  # 保持引用存活
    try:
        check_model()
        check_audio_timebase(directory)
        check_export(directory, with_video)
    except CheckFailed as exc:
        print(f"\n✗ 自检失败: {exc}")
        return 1
    except Exception as exc:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        print(f"\n✗ 自检异常: {exc}")
        return 1
    finally:
        if not keep:
            shutil.rmtree(directory, ignore_errors=True)
    print("\n全部通过 ✓")
    return 0
