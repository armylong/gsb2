"""合成测试片：插入冻结、慢速变化、静态画面、黑场、开头/结尾冻结。

片段都按**帧下标**定义，实际时间范围由生成后 ffprobe 读到的逐帧时长计算，
所以同时覆盖了"不等间隔帧(VFR)"的场景。

生成的测试片刻意使用 8 帧一循环的不等间隔时长(33/67/50/33/100/50/34/66 ms)，
并为末帧补一个"哨兵帧"再精确裁剪，从而保证容器里每帧展示时长与脚本设定一致。
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

import numpy as np

from .timeline import FFmpegError, VideoTimeline, read_timeline, require_binary

# 每 8 帧循环一次的时长(毫秒)，总和 433ms
DURATION_CYCLE_MS = [33, 67, 50, 33, 100, 50, 34, 66]

DEFAULT_SIZE = (640, 360)


@dataclass
class PlannedSegment:
    name: str
    kind: str  # freeze / static / black / short_freeze / slow_change / motion
    start_frame: int
    end_frame: int
    expect_detect: bool = True
    expect_auto_kind: str = "freeze"
    note: str = ""


DEFAULT_PLAN: List[PlannedSegment] = [
    PlannedSegment("head_freeze", "freeze", 0, 11, True, "freeze", "开头即冻结"),
    PlannedSegment("motion_1", "motion", 12, 70, False, ""),
    PlannedSegment("insert_freeze", "freeze", 71, 90, True, "freeze", "中段插入冻结"),
    PlannedSegment("motion_2", "motion", 91, 170, False, ""),
    PlannedSegment("slow_change", "slow_change", 171, 260, False, "", "慢速变化，应被漂移约束排除"),
    PlannedSegment("static_scene", "static", 261, 300, True, "static", "静态画面"),
    PlannedSegment("black_scene", "black", 301, 315, True, "black", "黑场"),
    PlannedSegment("short_freeze", "short_freeze", 316, 319, False, "", "仅 4 帧，短于最短持续时间"),
    PlannedSegment("motion_3", "motion", 320, 400, False, ""),
    PlannedSegment("tail_freeze", "freeze", 401, 412, True, "freeze", "结尾冻结"),
]


def pts_ms_for_frame(index: int) -> int:
    cycle = len(DURATION_CYCLE_MS)
    period = sum(DURATION_CYCLE_MS)
    offset = sum(DURATION_CYCLE_MS[: index % cycle])
    return (index // cycle) * period + offset


def duration_ms_for_frame(index: int) -> int:
    return DURATION_CYCLE_MS[index % len(DURATION_CYCLE_MS)]


def _build_scene(width: int, height: int, pad: int = 5200) -> np.ndarray:
    """一张横向可平移的合成背景，带足够的纹理以便逐帧变化可测。"""
    canvas_w = width + pad
    y = np.linspace(0, 1, height, dtype=np.float32)[:, None]
    x = np.linspace(0, 1, canvas_w, dtype=np.float32)[None, :]
    base = np.zeros((height, canvas_w, 3), dtype=np.float32)
    base[:, :, 0] = 30 + 140 * y + 25 * np.sin(x * 8 * np.pi)
    base[:, :, 1] = 60 + 110 * x + 20 * np.cos(y * 5 * np.pi)
    base[:, :, 2] = 120 + 60 * np.sin((x + y) * 4 * np.pi)

    # 斜条纹：给平移带来稳定的像素梯度
    stripe = (np.sin((x * 2.0 + y) * 22.0) > 0.6).astype(np.float32)
    base += stripe[:, :, None] * np.array([60, 40, 10], dtype=np.float32)

    # 几个彩色方块，便于人眼判断画面是否移动
    rng = np.random.default_rng(20240101)
    for _ in range(18):
        bx = int(rng.integers(0, canvas_w - 120))
        by = int(rng.integers(0, height - 80))
        bw = int(rng.integers(50, 130))
        bh = int(rng.integers(30, 80))
        color = rng.integers(40, 240, size=3).astype(np.float32)
        base[by : by + bh, bx : bx + bw] = color
    return np.clip(base, 0, 255).astype(np.uint8)


def _window(scene: np.ndarray, offset: float, width: int, height: int) -> np.ndarray:
    """从合成背景里取一帧，带亚像素平移(双线性)。"""
    limit = scene.shape[1] - width - 2
    if offset > limit or offset < 0:
        raise ValueError(f"场景位移越界: {offset} (上限 {limit})")
    x0 = int(np.floor(offset))
    frac = float(offset - x0)
    a = scene[:, x0 : x0 + width + 1].astype(np.float32)
    b = scene[:, x0 + 1 : x0 + 2 + width].astype(np.float32)
    out = a * (1.0 - frac) + b * frac
    return np.clip(out[:, :width], 0, 255).astype(np.uint8)


def _static_frame(width: int, height: int) -> np.ndarray:
    """内容丰富的静态画面。"""
    y = np.arange(height, dtype=np.int16)[:, None]
    x = np.arange(width, dtype=np.int16)[None, :]
    frame = np.zeros((height, width, 3), dtype=np.uint8)
    frame[:, :, 0] = (x * 255 // width).astype(np.uint8)
    frame[:, :, 1] = (y * 255 // height).astype(np.uint8)
    frame[:, :, 2] = (((x // 40 + y // 40) % 2) * 160 + 40).astype(np.uint8)
    for cx, cy, r in ((120, 90, 40), (330, 240, 55), (500, 120, 30)):
        mask = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
        frame[mask] = (240, 220, 30)
    return frame


def _badge(img: np.ndarray, tag: int) -> np.ndarray:
    """在冻结画面上叠加一块醒目标记，方便人工一眼认出"这是冻结段"。

    标记是静态的(同一段内不变)，因此不影响检测结果。
    """
    out = img.copy()
    h, w = out.shape[:2]
    palette = [
        (255, 255, 255),
        (255, 214, 10),
        (60, 220, 255),
        (255, 90, 120),
        (120, 255, 140),
    ]
    color = palette[tag % len(palette)]
    # 左上角实心方块 + 右侧竖条：不同冻结段数量不同
    size = max(10, h // 10)
    out[8 : 8 + size, 8 : 8 + size] = color
    bars = 1 + tag % 4
    for i in range(bars):
        x0 = w - 16 - (i + 1) * (size // 2 + 6)
        out[h - 8 - size : h - 8, x0 : x0 + size // 2] = color
    # 一条贯穿的细线，避免标记与场景同色时不可见
    out[8 + size + 4 : 8 + size + 8, 8 : w - 8] = color
    return out


def build_frames(
    plan: List[PlannedSegment], width: int, height: int
) -> List[np.ndarray]:
    """按计划渲染所有帧。"""
    scene = _build_scene(width, height)
    static_img = _static_frame(width, height)
    black = np.zeros((height, width, 3), dtype=np.uint8)
    frames: List[np.ndarray] = []
    freeze_frames: Dict[str, np.ndarray] = {}

    motion_offset = 0.0
    slow_offset = 0.0
    for seg in plan:
        for index in range(seg.start_frame, seg.end_frame + 1):
            if seg.kind == "freeze":
                img = freeze_frames.get(seg.name)
                if img is None:
                    # 每个冻结段使用一段独立且与前后明显不同的画面
                    offset = 40.0 + 220.0 * (len(freeze_frames) + 1)
                    base = _window(scene, offset, width, height)
                    img = _badge(base, len(freeze_frames) + 1)
                    freeze_frames[seg.name] = img
                frames.append(img.copy())
            elif seg.kind == "short_freeze":
                img = _badge(_window(scene, 1560.0, width, height), 4)
                frames.append(img.copy())
            elif seg.kind == "static":
                frames.append(static_img.copy())
            elif seg.kind == "black":
                frames.append(black.copy())
            elif seg.kind == "slow_change":
                slow_offset += 0.6  # 每帧亚像素级缓慢移动
                frames.append(_window(scene, 900.0 + slow_offset, width, height))
            else:  # motion
                motion_offset += 11.0
                frames.append(_window(scene, motion_offset, width, height))
    return frames


def _setpts_expression(frame_count: int) -> str:
    """按帧下标生成精确的 PTS 表达式(毫秒 -> 秒)。"""
    cycle = len(DURATION_CYCLE_MS)
    period = sum(DURATION_CYCLE_MS)
    prefixes: List[int] = []
    running = 0
    for d in DURATION_CYCLE_MS:
        prefixes.append(running)
        running += d
    inner = str(prefixes[-1])
    for i in range(cycle - 2, -1, -1):
        inner = f"if(eq(mod(N\\,{cycle}),{i}),{prefixes[i]},{inner})"
    return f"trunc(N/{cycle})*{period}+({inner})"


def write_video(
    frames: List[np.ndarray],
    out_path: str,
    crf: int = 18,
) -> None:
    """把帧序列写成每帧展示时长精确可控的 mp4。

    做法：把帧序号 N 映射到设定的 PTS(毫秒)；额外补一个哨兵帧(与末帧相同)，
    让编码器知道末帧的结束时间；最后无损重封装并按总时长裁剪掉哨兵帧。
    """
    if not frames:
        raise ValueError("没有帧可写")
    height, width = frames[0].shape[:2]
    frame_count = len(frames)
    total_ms = pts_ms_for_frame(frame_count)
    expr = _setpts_expression(frame_count)
    raw = np.ascontiguousarray(np.stack(frames)).tobytes()
    sentinel = np.ascontiguousarray(frames[-1]).tobytes()

    tmp_path = out_path + ".part.mp4"
    cmd = [
        require_binary("ffmpeg"),
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{width}x{height}",
        "-framerate",
        "1000",
        "-i",
        "pipe:0",
        "-vf",
        f"setpts='({expr})/1000/TB'",
        "-fps_mode",
        "passthrough",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-bf",
        "0",
        "-enc_time_base",
        "1/90000",
        "-video_track_timescale",
        "90000",
        tmp_path,
    ]
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE
    )
    assert proc.stdin is not None
    try:
        proc.stdin.write(raw)
        proc.stdin.write(sentinel)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
    if proc.stderr is not None:
        proc.stderr.close()
    if proc.wait() != 0:
        raise FFmpegError(f"合成测试片失败: {stderr.strip()[-500:]}")

    # 重封装并裁掉哨兵帧，使容器总时长正好是设定值
    cmd2 = [
        require_binary("ffmpeg"),
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-i",
        tmp_path,
        "-c",
        "copy",
        "-t",
        f"{total_ms / 1000.0:.6f}",
        "-movflags",
        "+faststart",
        out_path,
    ]
    proc2 = subprocess.run(cmd2, capture_output=True, text=True)
    os.unlink(tmp_path)
    if proc2.returncode != 0 or not os.path.exists(out_path):
        raise FFmpegError(f"重封装测试片失败: {proc2.stderr.strip()[-500:]}")


def ground_truth(
    timeline: VideoTimeline,
    plan: List[PlannedSegment],
    params_snapshot: Optional[dict] = None,
) -> Dict[str, object]:
    """根据生成后的真实时间轴，产出可机读的期望结果。"""
    entries = []
    for seg in plan:
        start = timeline.pts[seg.start_frame]
        end = timeline.frame_end(seg.end_frame)
        entries.append(
            {
                "name": seg.name,
                "kind": seg.kind,
                "start_frame": seg.start_frame,
                "end_frame": seg.end_frame,
                "start_ms": int(round(start * 1000)),
                "end_ms": int(round(end * 1000)),
                "duration_ms": int(round((end - start) * 1000)),
                "expect_detect": seg.expect_detect,
                "expect_auto_kind": seg.expect_auto_kind if seg.expect_detect else "",
                "note": seg.note,
            }
        )
    return {
        "video": os.path.abspath(timeline.path),
        "frame_count": timeline.frame_count,
        "duration_ms": int(round(timeline.duration * 1000)),
        "is_vfr": timeline.is_vfr,
        "start_time": timeline.start_time,
        "timing_exact_frames": timeline.timing_exact_count(),
        "params": params_snapshot,
        "segments": entries,
    }


def generate_sample(
    out_dir: str,
    width: int = DEFAULT_SIZE[0],
    height: int = DEFAULT_SIZE[1],
    crf: int = 18,
    params_snapshot: Optional[dict] = None,
) -> Dict[str, object]:
    """生成测试片和 ground truth。返回 {"video": path, "truth": path, ...}。"""
    os.makedirs(out_dir, exist_ok=True)
    video_path = os.path.join(out_dir, "freeze_sample.mp4")
    truth_path = os.path.join(out_dir, "freeze_sample.truth.json")
    frames = build_frames(DEFAULT_PLAN, width, height)
    write_video(frames, video_path, crf=crf)
    timeline = read_timeline(video_path)
    if timeline.frame_count != len(frames):
        raise FFmpegError(
            f"合成后帧数不符: 期望 {len(frames)}，实际 {timeline.frame_count}"
        )
    truth = ground_truth(timeline, DEFAULT_PLAN, params_snapshot)
    with open(truth_path, "w", encoding="utf-8") as fh:
        json.dump(truth, fh, ensure_ascii=False, indent=2)
    return {
        "video": video_path,
        "truth": truth_path,
        "truth_data": truth,
        "timeline": timeline,
        "frames": len(frames),
    }
