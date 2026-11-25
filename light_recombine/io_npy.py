"""浮点 npy 通道读写与调整参数的 JSON 持久化。

安全约定: npy 一律 allow_pickle=False 加载, 拒绝对象数组;
解析外部文件时不执行其中任何代码。
"""

from __future__ import annotations

import json
import os
from typing import Iterable

import numpy as np

from .channels import CHANNEL_ORDER, ChannelSet, LoadedChannel, LoadStatus
from .composite import DisplayParams, ParamState

PARAMS_VERSION = 1


def _coerce_to_rgb_float(arr: np.ndarray, path: str) -> np.ndarray:
    """把加载的数组规范为 HxWx3 float32, 灰度图按同值扩成三通道。"""
    if arr.dtype == object:
        raise ValueError("不支持对象数组, 请保存为数值型 ndarray")
    if arr.ndim == 2:
        arr = np.repeat(arr[:, :, None], 3, axis=2)
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError(f"期望 HxWx3 或 HxW 数组, 实际形状 {arr.shape}")
    out = arr.astype(np.float32, copy=False)
    if not np.isfinite(out).all():
        raise ValueError("数组包含 NaN 或 Inf, 无法参与线性合成")
    return np.ascontiguousarray(out)


def load_channel_file(
    path: str | None,
    reference_shape: tuple[int, int] | None = None,
) -> LoadedChannel:
    """加载单个 npy 通道。

    reference_shape 为 (H, W) 时, 尺寸不符会标记 SHAPE_MISMATCH 而不是
    截断或缩放——绝不拿别的数据顶替。
    """
    name = _guess_channel_name(path)
    if not path:
        return LoadedChannel(name, LoadStatus.MISSING, path=path,
                             detail="未指定文件")
    if not os.path.isfile(path):
        return LoadedChannel(name, LoadStatus.MISSING, path=path,
                             detail=f"文件不存在: {path}")
    try:
        arr = np.load(path, allow_pickle=False)
        data = _coerce_to_rgb_float(arr, path)
    except Exception as exc:  # 加载失败要带原因展示, 不能拖垮整套加载
        return LoadedChannel(name, LoadStatus.BAD_DATA, path=path,
                             detail=str(exc))
    if reference_shape is not None and data.shape[:2] != reference_shape:
        return LoadedChannel(
            name, LoadStatus.SHAPE_MISMATCH, path=path,
            detail=(f"尺寸 {data.shape[1]}x{data.shape[0]} 与参考 "
                    f"{reference_shape[1]}x{reference_shape[0]} 不一致"),
        )
    return LoadedChannel(name, LoadStatus.OK, data=data, path=path,
                         detail=f"{data.shape[1]}x{data.shape[0]} float32")


def _guess_channel_name(path: str | None) -> str:
    if not path:
        return "unknown"
    stem = os.path.splitext(os.path.basename(path))[0].lower()
    for name in CHANNEL_ORDER:
        if name in stem:
            return name
    return "unknown"


def load_channels(paths: dict[str, str | None]) -> ChannelSet:
    """按固定顺序加载通道, 以第一个成功通道的尺寸为参考尺寸。"""
    result: dict[str, LoadedChannel] = {}
    reference_shape: tuple[int, int] | None = None
    # 先确定参考尺寸
    for name in CHANNEL_ORDER:
        ch = load_channel_file(paths.get(name))
        if ch.available:
            reference_shape = (ch.data.shape[0], ch.data.shape[1])
            break
    for name in CHANNEL_ORDER:
        ch = load_channel_file(paths.get(name), reference_shape)
        # 文件名不规范时以字典键作为通道名
        ch.name = name
        result[name] = ch
    return ChannelSet(channels=result)


def save_params(
    path: str,
    params: ParamState,
    display: DisplayParams,
    source_paths: dict[str, str | None],
) -> None:
    """把倍率/独显/显示参数与来源路径存成 JSON, 供重开复现。"""
    payload = {
        "version": PARAMS_VERSION,
        "multipliers": {k: float(v) for k, v in params.multipliers.items()},
        "solo": dict(params.solo),
        "display": {
            "exposure_ev": float(display.exposure_ev),
            "tonemap": display.tonemap,
        },
        "source_paths": dict(source_paths),
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def load_params(path: str) -> tuple[ParamState, DisplayParams, dict[str, str]]:
    """读回参数文件; 缺字段用默认值补, 未知通道名忽略。"""
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    defaults = ParamState()
    mult = dict(defaults.multipliers)
    for k, v in payload.get("multipliers", {}).items():
        if k in CHANNEL_ORDER:
            mult[k] = float(v)
    solo = dict(defaults.solo)
    for k, v in payload.get("solo", {}).items():
        if k in CHANNEL_ORDER:
            solo[k] = bool(v)
    d = payload.get("display", {})
    display = DisplayParams(
        exposure_ev=float(d.get("exposure_ev", 0.0)),
        tonemap=str(d.get("tonemap", "reinhard")),
    )
    sources = {k: str(v) for k, v in payload.get("source_paths", {}).items()
               if k in CHANNEL_ORDER}
    return ParamState(multipliers=mult, solo=solo), display, sources


def save_channel_npy(path: str, data: np.ndarray) -> None:
    """供示例导出与测试使用的 npy 写出。"""
    np.save(path, np.ascontiguousarray(data, dtype=np.float32))
