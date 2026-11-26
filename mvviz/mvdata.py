"""用 PyAV(libavcodec) 解码视频并提取编码器记录的运动向量.

关键点（在 ffmpeg 9 / PyAV 19 上实测确认）:
  * 解码器需打开 AV_CODEC_FLAG2_EXPORT_MVS(1<<28)，帧侧数据才带运动向量；
    ffmpeg 9 的 ffprobe 已不再把该侧数据的数组内容打印出来，所以走 PyAV。
  * PyAV 的 decode() 按 pts 升序产出，即实际显示顺序，本模块的帧号就是显示序号。
  * 向量数组为结构化 ndarray，字段与 AVMotionVector 一一对应：
    source, w, h, src_x, src_y, dst_x, dst_y, flags, motion_x, motion_y, motion_scale
  * 实测 flags 恒为 0，方向信息在 source 上：
    source < 0 -> 参考过去帧；source > 0 -> 参考未来帧（B 帧的后向预测）。
    source 是相对当前帧显示序号的 POC 偏移，ref_display = 当前帧号 + source。
  * 像素单位向量 = motion_x / motion_scale（H.264 为 1/4 像素）。
  * 画内(I)帧没有运动向量侧数据。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import av
import numpy as np

EXPORT_MVS_FLAG = 1 << 28  # AV_CODEC_FLAG2_EXPORT_MVS

# 帧类型编号（libavutil AVPictureType）
_PICT_NAMES = {1: "I", 2: "P", 3: "B", 4: "S", 5: "SI", 6: "SP", 7: "BI"}


@dataclass(frozen=True)
class MotionVector:
    """一条运动向量，几何坐标均为像素（dst/src 已是整数像素位置）。"""

    block_x: int          # 块左上角 x
    block_y: int
    block_w: int          # 实际块宽（H.264 可能是 16x16/8x16/8x8 等）
    block_h: int
    src_x: float          # 参考块中心（像素，浮点）
    src_y: float
    dst_x: float          # 当前块中心（像素，浮点）
    dst_y: float
    mv_x: float           # 像素单位向量分量（块中心 -> 参考块中心）
    mv_y: float
    source_poc: int       # 原始 source 字段（相对 POC 偏移）
    direction: str        # "past" | "future"
    ref_frame: int | None # 推断出的参考帧显示序号；无法确认时为 None
    ref_known: bool
    length: float         # 向量长度（像素）

    def to_dict(self) -> dict:
        return {
            "block": [self.block_x, self.block_y, self.block_w, self.block_h],
            "block_center": [self.dst_x, self.dst_y],
            "reference_center": [self.src_x, self.src_y],
            "motion_px": [round(self.mv_x, 3), round(self.mv_y, 3)],
            "length_px": round(self.length, 3),
            "direction": self.direction,
            "source_poc": self.source_poc,
            "ref_frame": self.ref_frame,
            "ref_known": self.ref_known,
        }


@dataclass
class FrameInfo:
    index: int
    pict_type: str
    key_frame: bool
    vectors: list[MotionVector]

    @property
    def has_vectors(self) -> bool:
        return bool(self.vectors)

    def status_text(self) -> str:
        """没向量时说明状态（需求 2）。"""
        if self.vectors:
            n_past = sum(v.direction == "past" for v in self.vectors)
            n_future = sum(v.direction == "future" for v in self.vectors)
            return (f"{self.pict_type} 帧，{len(self.vectors)} 条向量"
                    f"（过去参考 {n_past} / 未来参考 {n_future}）")
        if self.pict_type == "I":
            return "I 帧（画内编码）：只做帧内预测，没有运动向量"
        return f"{self.pict_type} 帧：编码器未导出运动向量（可能全部为跳过/直拷块）"


class VideoData:
    """加载一个视频：所有解码帧(RGB) + 每帧类型与运动向量，按显示顺序排列。"""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self.frames: list[np.ndarray] = []
        self.frame_info: list[FrameInfo] = []
        self.width = self.height = 0
        self._load()

    def _load(self) -> None:
        container = av.open(self.path)
        stream = container.streams.video[0]
        stream.codec_context.flags2 |= EXPORT_MVS_FLAG

        display_index = 0
        for frame in container.decode(stream):
            if display_index == 0:
                self.width, self.height = frame.width, frame.height
            rgb = frame.to_ndarray(format="rgb24")
            self.frames.append(rgb)

            vectors: list[MotionVector] = []
            for side_type, side in frame.side_data.items():
                if side_type.name != "MOTION_VECTORS":
                    continue
                arr = side.to_ndarray()
                vectors.extend(self._parse_vectors(arr, display_index))

            pict = _PICT_NAMES.get(int(frame.pict_type), str(frame.pict_type))
            self.frame_info.append(FrameInfo(
                index=display_index,
                pict_type=pict,
                key_frame=bool(frame.key_frame),
                vectors=vectors,
            ))
            display_index += 1
        container.close()

    def _parse_vectors(self, arr: np.ndarray, frame_index: int) -> list[MotionVector]:
        out: list[MotionVector] = []
        for row in arr:
            scale = int(row["motion_scale"]) or 4
            mv_x = float(row["motion_x"]) / scale
            mv_y = float(row["motion_y"]) / scale
            source = int(row["source"])
            if source < 0:
                direction = "past"
            elif source > 0:
                direction = "future"
            else:
                # source==0 在 H.264 里不合法；无法确认方向时如实标注
                direction = "unknown"
            dst_x = float(row["dst_x"])
            dst_y = float(row["dst_y"])
            src_x = float(row["src_x"])
            src_y = float(row["src_y"])
            length = math_hypot(mv_x, mv_y)
            out.append(MotionVector(
                block_x=int(row["dst_x"] - row["w"] // 2),
                block_y=int(row["dst_y"] - row["h"] // 2),
                block_w=int(row["w"]),
                block_h=int(row["h"]),
                src_x=src_x, src_y=src_y, dst_x=dst_x, dst_y=dst_y,
                mv_x=mv_x, mv_y=mv_y,
                source_poc=source,
                direction=direction,
                ref_frame=None,
                ref_known=False,
                length=length,
            ))
        return out

    def finalize_references(self) -> None:
        """全部帧解出后，用总帧数校验 source 偏移能否落到合法显示帧上。"""
        total = len(self.frame_info)
        for info in self.frame_info:
            for v in info.vectors:
                if v.direction == "unknown":
                    continue
                candidate = info.index + v.source_poc
                if 0 <= candidate < total and candidate != info.index:
                    # 方向与偏移符号必须自洽，否则按“无法确认”处理
                    if (v.direction == "past" and candidate < info.index) or \
                       (v.direction == "future" and candidate > info.index):
                        object.__setattr__(v, "ref_frame", candidate)
                        object.__setattr__(v, "ref_known", True)

    @property
    def frame_count(self) -> int:
        return len(self.frames)

    def get_frame(self, index: int) -> np.ndarray:
        return self.frames[index]

    def get_info(self, index: int) -> FrameInfo:
        return self.frame_info[index]

    def vectors_at(self, index: int) -> list[MotionVector]:
        return self.frame_info[index].vectors


def math_hypot(x: float, y: float) -> float:
    return float(np.hypot(x, y))


def load_video(path: str | Path) -> VideoData:
    vd = VideoData(path)
    vd.finalize_references()
    return vd
