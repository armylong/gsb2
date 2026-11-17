"""单条顺序时间线的数据模型与导出流水线。"""
from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass

from . import MAX_CLIPS
from .concat import concat_clips
from .normalize import normalize_clip
from .probe import MediaInfo, ProbeError, probe_media
from .runner import FFmpegError


class ProjectError(ValueError):
    """时间线操作非法（超过 6 段、序号越界、设置不合法等）。"""


@dataclass
class Clip:
    clip_id: str
    path: str
    # probe 成功后填充；失败时为 None，error 记录原因
    info: MediaInfo | None = None
    error: str | None = None
    # 已生成的统一规格中间片路径（导出成功后保留，便于复导出时复用）
    normalized_path: str | None = None

    def to_dict(self) -> dict:
        return {
            "clip_id": self.clip_id,
            "path": self.path,
            "error": self.error,
            "normalized_path": self.normalized_path,
            "info": None if self.info is None else asdict(self.info),
        }

    @property
    def ok(self) -> bool:
        return self.info is not None and self.error is None


@dataclass
class ExportSettings:
    width: int = 0          # 0 表示沿用首段宽度
    height: int = 0
    fps: float = 0.0        # 0 表示沿用首段帧率
    fit: str = "contain"    # contain=黑边填充, cover=居中裁切
    silent_policy: str = "mute"  # 无声音片段的统一规则：补等长静音轨

    def validate(self) -> None:
        if self.fit not in ("contain", "cover"):
            raise ProjectError("画面适配方式只能是 contain（填充）或 cover（裁切）")
        if self.silent_policy != "mute":
            raise ProjectError("无声音片段仅支持统一补静音（mute）规则")
        if self.width < 0 or self.height < 0:
            raise ProjectError("输出尺寸不能为负数")
        if (self.width == 0) != (self.height == 0):
            raise ProjectError("输出宽高必须同时指定，或同时为 0 表示沿用首段")
        if self.width and (self.width < 64 or self.height < 64):
            raise ProjectError("输出尺寸过小（至少 64x64）")
        if self.width and (self.width % 2 or self.height % 2):
            raise ProjectError("输出宽高必须为偶数（H.264/yuv420p 限制）")
        if self.fps < 0:
            raise ProjectError("帧率不能为负数")
        if self.fps and self.fps < 1:
            raise ProjectError("输出帧率至少为 1fps")

    def resolve(self, first: MediaInfo) -> "ResolvedSettings":
        return ResolvedSettings(
            width=self.width or first.width,
            height=self.height or first.height,
            fps=self.fps or round(first.fps, 3),
            fit=self.fit,
            silent_policy=self.silent_policy,
        )


@dataclass
class ResolvedSettings:
    width: int
    height: int
    fps: float
    fit: str
    silent_policy: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ExportResult:
    output_path: str
    resolved: ResolvedSettings
    expected_duration: float
    intermediate_paths: list[str]
    per_clip_durations: list[float]
    failed_clip_id: str | None = None
    failed_stage: str | None = None      # normalize / concat
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


class Project:
    """内存中的时间线；持久化由 save/load 负责。"""

    def __init__(self, work_dir: str):
        self.work_dir = os.path.abspath(work_dir)
        os.makedirs(self.work_dir, exist_ok=True)
        self.clips: list[Clip] = []
        self.settings = ExportSettings()
        self.last_result: ExportResult | None = None

    # ---------- 片段管理（最多 6 段） ----------

    def add_clip(self, path: str) -> Clip:
        if len(self.clips) >= MAX_CLIPS:
            raise ProjectError(f"最多只能添加 {MAX_CLIPS} 段视频")
        if not os.path.isfile(path):
            raise ProjectError(f"文件不存在：{path}")
        clip = Clip(clip_id=uuid.uuid4().hex[:12], path=os.path.abspath(path))
        self._refresh_clip(clip)
        self.clips.append(clip)
        return clip

    def remove_clip(self, clip_id: str) -> None:
        index = self._index_of(clip_id)
        del self.clips[index]

    def move_clip(self, clip_id: str, direction: int) -> None:
        index = self._index_of(clip_id)
        target = index + direction
        if not 0 <= target < len(self.clips):
            raise ProjectError("片段已在边界，无法继续移动")
        self.clips[index], self.clips[target] = self.clips[target], self.clips[index]

    def reorder(self, ordered_ids: list[str]) -> None:
        if sorted(ordered_ids) != sorted(c.clip_id for c in self.clips):
            raise ProjectError("重排后的片段 ID 列表与当前时间线不一致")
        by_id = {c.clip_id: c for c in self.clips}
        self.clips = [by_id[cid] for cid in ordered_ids]

    def replace_clip(self, clip_id: str, new_path: str) -> Clip:
        """只替换出错片段（也允许替换任意片段），保留时间线位置与其他片段结果。"""
        if not os.path.isfile(new_path):
            raise ProjectError(f"文件不存在：{new_path}")
        index = self._index_of(clip_id)
        clip = Clip(clip_id=uuid.uuid4().hex[:12], path=os.path.abspath(new_path))
        self._refresh_clip(clip)
        self.clips[index] = clip
        return clip

    def re_probe(self) -> None:
        for clip in self.clips:
            self._refresh_clip(clip)

    def _refresh_clip(self, clip: Clip) -> None:
        try:
            clip.info = probe_media(clip.path)
            clip.error = None
        except ProbeError as exc:
            clip.info = None
            clip.error = str(exc)
        clip.normalized_path = None  # 源文件可能已变化，旧中间片作废

    def _index_of(self, clip_id: str) -> int:
        for i, clip in enumerate(self.clips):
            if clip.clip_id == clip_id:
                return i
        raise ProjectError(f"找不到片段：{clip_id}")

    # ---------- 导出前信息 ----------

    @property
    def valid_clips(self) -> list[Clip]:
        return [c for c in self.clips if c.ok]

    def estimated_duration(self) -> float:
        """预计总时长 = 各有效片段容器时长之和（统一帧率不改变时长）。"""
        return round(sum(c.info.duration for c in self.valid_clips), 3)

    def effective_settings(self) -> ResolvedSettings:
        if not self.valid_clips:
            raise ProjectError("时间线上没有可导出的有效片段")
        self.settings.validate()
        return self.settings.resolve(self.valid_clips[0].info)

    def junction_report(self) -> list[dict]:
        """导出前的交界检查：轨道时长差、帧率/尺寸变化点。"""
        report = []
        valid = self.valid_clips
        for i in range(1, len(valid)):
            prev, cur = valid[i - 1], valid[i]
            issues = []
            if prev.info.has_audio != cur.info.has_audio:
                issues.append(
                    "声音状态变化：无声音片段将补等长静音轨，不会占压后续声音")
            for clip in (prev, cur):
                if (clip.info.has_audio and clip.info.audio_duration is not None
                        and abs(clip.info.audio_duration - clip.info.duration) > 0.1):
                    issues.append(
                        f"片段 {os.path.basename(clip.path)} 音轨时长 "
                        f"{clip.info.audio_duration:.3f}s 与画面 "
                        f"{clip.info.duration:.3f}s 不一致，导出时将以画面时长为准对齐")
            if prev.info.fps != cur.info.fps:
                issues.append(f"帧率变化 {prev.info.fps:g} → {cur.info.fps:g}fps，统一到输出帧率")
            if (prev.info.width, prev.info.height) != (cur.info.width, cur.info.height):
                issues.append("画面尺寸变化，按所选 contain/cover 方式适配，不拉伸")
            report.append({
                "between": [prev.clip_id, cur.clip_id],
                "names": [os.path.basename(prev.path), os.path.basename(cur.path)],
                "issues": issues,
            })
        return report

    # ---------- 导出 ----------

    def export(self, output_path: str, progress_cb=None) -> ExportResult:
        """流水线：校验 → 逐段统一规格（每段独立报错）→ concat 流拷贝。

        失败时返回带 failed_clip_id/failed_stage/error 的 ExportResult，
        已完成的中间片保留，替换出错片段后可直接再次导出。
        """
        if not self.clips:
            raise ProjectError("时间线为空，请先添加片段")
        invalid = [c for c in self.clips if not c.ok]
        if invalid:
            raise ProjectError(
                "存在无法识别的片段，请先移除或替换："
                + "；".join(f"{os.path.basename(c.path)}（{c.error}）" for c in invalid))

        resolved = self.effective_settings()
        expected = self.estimated_duration()
        # 中间片目录用绝对路径：concat demuxer 按进程 CWD 解析列表里的相对路径，
        # 而列表文件位于 work_dir，两者可能不同，必须写绝对路径才能稳定打开
        intermediates_dir = os.path.abspath(
            os.path.join(self.work_dir, "intermediates"))
        os.makedirs(intermediates_dir, exist_ok=True)

        per_clip_durations: list[float] = []
        intermediate_paths: list[str] = []
        total_weight = len(self.clips) + 1  # 归一化 N 段 + 拼接 1 步

        def stage_progress(clip_index: int):
            def _cb(ratio: float, text: str):
                if progress_cb:
                    overall = (clip_index + ratio) / total_weight
                    progress_cb(overall, text)
            return _cb

        for index, clip in enumerate(self.clips):
            try:
                target = os.path.join(
                    intermediates_dir, f"{clip.clip_id}_norm.mp4")
                if (clip.normalized_path and os.path.isfile(clip.normalized_path)
                        and clip.normalized_path == target):
                    pass  # 复用上次成功产物（替换片段会重置该字段）
                else:
                    normalize_clip(
                        clip.info, target,
                        width=resolved.width, height=resolved.height,
                        fps=resolved.fps, fit=resolved.fit,
                        progress_cb=stage_progress(index),
                    )
                    clip.normalized_path = target
                intermediate_paths.append(target)
                per_clip_durations.append(clip.info.duration)
            except FFmpegError as exc:
                result = ExportResult(
                    output_path=output_path, resolved=resolved,
                    expected_duration=expected,
                    intermediate_paths=intermediate_paths,
                    per_clip_durations=per_clip_durations,
                    failed_clip_id=clip.clip_id, failed_stage="normalize",
                    error=f"片段「{os.path.basename(clip.path)}」统一规格失败：{exc}",
                )
                self.last_result = result
                return result

        try:
            if progress_cb:
                progress_cb(len(self.clips) / total_weight, "流拷贝拼接最终文件")
            concat_clips(intermediate_paths, os.path.abspath(output_path),
                         work_dir=self.work_dir)
        except FFmpegError as exc:
            result = ExportResult(
                output_path=output_path, resolved=resolved,
                expected_duration=expected,
                intermediate_paths=intermediate_paths,
                per_clip_durations=per_clip_durations,
                failed_clip_id=None, failed_stage="concat",
                error=f"最终拼接失败：{exc}",
            )
            self.last_result = result
            return result

        if progress_cb:
            progress_cb(1.0, "导出完成")
        result = ExportResult(
            output_path=os.path.abspath(output_path), resolved=resolved,
            expected_duration=expected,
            intermediate_paths=intermediate_paths,
            per_clip_durations=per_clip_durations,
        )
        self.last_result = result
        self.save()
        return result

    # ---------- 持久化 ----------

    def save(self, path: str | None = None) -> str:
        path = path or os.path.join(self.work_dir, "project.json")
        payload = {
            "work_dir": self.work_dir,
            "settings": asdict(self.settings),
            "clips": [c.to_dict() for c in self.clips],
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        return path

    @classmethod
    def load(cls, path: str) -> "Project":
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
        project = cls(work_dir=payload["work_dir"])
        project.settings = ExportSettings(**payload["settings"])
        for raw in payload["clips"]:
            info_raw = raw.get("info")
            clip = Clip(
                clip_id=raw["clip_id"], path=raw["path"],
                info=MediaInfo(**info_raw) if info_raw else None,
                error=raw.get("error"),
                normalized_path=raw.get("normalized_path"),
            )
            project.clips.append(clip)
        return project
