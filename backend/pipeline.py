"""任务管理与取帧流水线。

每个导入的视频对应一个 Job，拥有独立的工作目录（以 job_id 命名），
多个任务之间的临时文件、帧图与结果互不覆盖。分析在后台线程中运行，
通过 threading.Event 取消；取消会终止对应的 ffmpeg 子进程。
"""

from __future__ import annotations

import os
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

from .ffmpeg_tools import (
    FrameInfo,
    ProbeError,
    build_extract_cmd,
    frames_are_vfr,
    list_frames,
    nearest_frame,
    probe_media,
    run_ffmpeg,
    run_scene_detect,
)

# 场景检测灵敏度（1~5，越高越敏感）到 ffmpeg scene 分数阈值的映射。
# 阈值越小，越多画面变化会被判定为“切换”。
SENSITIVITY_THRESHOLDS = {
    1: 0.60,
    2: 0.40,
    3: 0.25,
    4: 0.12,
    5: 0.05,
}

EXTRACT_CHUNK_SIZE = 12


class AnalysisError(Exception):
    """参数或分析过程中的可向用户展示的错误。"""


class _AnalysisCanceled(Exception):
    """内部信号：分析已被取消，状态已收尾。"""


@dataclass
class Candidate:
    """一张候选截图。同一真实帧在全局只会存在一条记录。"""

    id: str
    frame_index: int          # ffprobe 枚举的真实解码帧序号
    requested_time: float     # 用户/策略请求的时间（秒）
    actual_time: float        # 实际选中帧的 pts_time（秒）
    source: str               # interval | scene | manual
    selected: bool = True
    image_ready: bool = False
    image_path: Optional[str] = None
    error: Optional[str] = None
    # 指向同一真实帧的其他请求时间（去重时记录，便于清单说明）
    merged_requests: list[float] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "frame_index": self.frame_index,
            "requested_time": round(self.requested_time, 6),
            "actual_time": round(self.actual_time, 6),
            "source": self.source,
            "selected": self.selected,
            "image_ready": self.image_ready,
            "has_image": self.image_path is not None,
            "error": self.error,
            "merged_requests": [round(t, 6) for t in self.merged_requests],
        }


@dataclass
class Job:
    id: str
    source_path: str           # 原视频绝对路径，只读，绝不修改
    original_name: str
    work_dir: str
    frames_dir: str
    probe: dict
    stream_index: int
    rotation: int
    duration: float
    frames: list[FrameInfo]
    is_vfr: bool
    status: str = "ready"      # ready | analyzing | ready_with_warnings | error | canceled
    progress: float = 0.0
    progress_stage: str = ""
    message: str = ""
    warnings: list[str] = field(default_factory=list)
    candidates: dict[str, Candidate] = field(default_factory=dict)
    frame_index_to_candidate: dict[int, str] = field(default_factory=dict)
    last_params: Optional[dict] = None
    analysis_generation: int = 0  # 每轮分析自增，旧轮结果一律作废
    cancel_event: Optional[threading.Event] = None
    lock: threading.RLock = field(default_factory=threading.RLock)

    def video_stream_info(self) -> dict:
        for s in self.probe["video_streams"]:
            if s["index"] == self.stream_index:
                return s
        return {}

    def public_status(self) -> dict:
        with self.lock:
            return {
                "id": self.id,
                "original_name": self.original_name,
                "status": self.status,
                "progress": round(self.progress, 4),
                "progress_stage": self.progress_stage,
                "message": self.message,
                "warnings": list(self.warnings),
                "stream_index": self.stream_index,
                "rotation": self.rotation,
                "duration": round(self.duration, 6),
                "is_vfr": self.is_vfr,
                "probe": self.probe,
                "analysis_generation": self.analysis_generation,
                "last_params": self.last_params,
                "candidates": [
                    self.candidates[cid].to_dict()
                    for cid in sorted(
                        self.candidates,
                        key=lambda c: self.candidates[c].actual_time,
                    )
                ],
            }


class JobManager:
    def __init__(self, work_root: str) -> None:
        self.work_root = os.path.abspath(work_root)
        os.makedirs(self.work_root, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self._jobs_lock = threading.Lock()
        # 分析任务串行排队即可；子进程内部才是耗时主力，避免同时解码过多视频
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="analyze")

    # ------------------------------------------------------------------ 生命周期

    def create_job(self, source_path: str, original_name: Optional[str] = None) -> Job:
        source_path = os.path.abspath(source_path)
        if not os.path.isfile(source_path):
            raise AnalysisError("视频文件不存在或无法读取。")
        try:
            probe = probe_media(source_path)
        except ProbeError as exc:
            raise AnalysisError(str(exc)) from exc
        video_streams = probe.get("video_streams", [])
        if not video_streams:
            raise AnalysisError("该文件不包含任何视频流，无法取帧（可能是纯音频文件）。")

        job_id = uuid.uuid4().hex
        work_dir = os.path.join(self.work_root, job_id)
        frames_dir = os.path.join(work_dir, "frames")
        os.makedirs(frames_dir, exist_ok=True)

        stream = video_streams[0]
        stream_index = stream["index"]
        duration = stream["duration"] or probe["format"].get("duration") or 0.0
        try:
            frames = list_frames(source_path, self._stream_position(probe, stream_index))
        except ProbeError as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise AnalysisError(f"无法枚举视频帧：{exc}") from exc
        if not frames:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise AnalysisError("视频流存在但无法解码出任何帧，文件可能已损坏。")

        job = Job(
            id=job_id,
            source_path=source_path,
            original_name=original_name or os.path.basename(source_path),
            work_dir=work_dir,
            frames_dir=frames_dir,
            probe=probe,
            stream_index=stream_index,
            rotation=stream["rotation"],
            duration=float(duration),
            frames=frames,
            is_vfr=frames_are_vfr(frames) or bool(stream.get("vfr_hint")),
        )
        with self._jobs_lock:
            self.jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Job:
        with self._jobs_lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise AnalysisError("任务不存在（可能已被删除）。")
        return job

    def remove_job(self, job_id: str) -> None:
        with self._jobs_lock:
            job = self.jobs.pop(job_id, None)
        if job is None:
            return
        if job.cancel_event is not None:
            job.cancel_event.set()
        shutil.rmtree(job.work_dir, ignore_errors=True)

    def switch_stream(self, job: Job, stream_index: int) -> None:
        """切换处理的视频流：重新枚举该流的真实帧并清空候选。"""
        with job.lock:
            if job.status == "analyzing":
                raise AnalysisError("请先取消或等待当前分析完成后再切换视频流。")
            positions = {
                s["index"]: pos for pos, s in enumerate(job.probe["video_streams"])
            }
            if stream_index not in positions:
                raise AnalysisError("指定的视频流不存在。")
            try:
                new_frames = list_frames(job.source_path, positions[stream_index])
            except ProbeError as exc:
                raise AnalysisError(f"无法读取该视频流：{exc}") from exc
            if not new_frames:
                raise AnalysisError("该视频流无法解码出任何帧。")
            stream = next(
                s for s in job.probe["video_streams"] if s["index"] == stream_index
            )
            self._clear_candidates_locked(job)
            job.frames = new_frames
            job.stream_index = stream_index
            job.rotation = stream["rotation"]
            job.duration = float(
                stream["duration"] or job.probe["format"].get("duration") or 0.0
            )
            job.is_vfr = frames_are_vfr(new_frames) or bool(stream.get("vfr_hint"))
            job.status = "ready"
            job.message = ""
            job.warnings = []
            job.last_params = None

    @staticmethod
    def _stream_position(probe: dict, stream_index: int) -> int:
        for pos, s in enumerate(probe["video_streams"]):
            if s["index"] == stream_index:
                return pos
        raise AnalysisError("指定的视频流不存在。")

    # ------------------------------------------------------------------ 分析入口

    def start_analysis(self, job: Job, params: dict) -> int:
        with job.lock:
            if job.status == "analyzing":
                raise AnalysisError("该任务已有分析正在进行，请先取消。")
            # 旧一轮若仍在运行，先终止（正常情况下上面的状态检查已拦住，这里兜底）
            if job.cancel_event is not None:
                job.cancel_event.set()
            job.analysis_generation += 1
            generation = job.analysis_generation
            job.cancel_event = threading.Event()
            job.status = "analyzing"
            job.progress = 0.0
            job.progress_stage = "准备分析参数"
            job.message = ""
            job.warnings = []
            job.last_params = dict(params)
            self._clear_candidates_locked(job)

        self._pool.submit(self._run_analysis, job.id, generation, dict(params))
        return generation

    def cancel_analysis(self, job: Job) -> None:
        with job.lock:
            event = job.cancel_event
            analyzing = job.status == "analyzing"
        if event is not None and analyzing:
            event.set()  # 工作线程检测到后会 terminate ffmpeg 并清理

    def _run_analysis(self, job_id: str, generation: int, params: dict) -> None:
        job = self.jobs.get(job_id)
        if job is None:
            return
        try:
            self._set_progress(job, generation, 0.02, "校验参数")
            requested = self._plan_requests(job, params)
            if self._is_canceled(job, generation):
                self._finalize_cancel(job, generation)
                return

            self._set_progress(job, generation, 0.10, "定位真实帧时间")
            candidates = self._build_candidates(job, generation, requested)
            if self._is_canceled(job, generation):
                self._finalize_cancel(job, generation)
                return

            self._extract_all(job, generation, candidates)
            if self._is_canceled(job, generation):
                self._finalize_cancel(job, generation)
                return

            with job.lock:
                if generation != job.analysis_generation:
                    return
                ready = [c for c in candidates if c.image_ready]
                failed = [c for c in candidates if not c.image_ready]
                for cand in candidates:
                    job.candidates[cand.id] = cand
                    job.frame_index_to_candidate[cand.frame_index] = cand.id
                job.status = "ready_with_warnings" if failed or job.warnings else "ready"
                job.progress = 1.0
                job.progress_stage = "完成"
                if not ready:
                    job.status = "error"
                    job.message = "所有候选帧均提取失败，视频可能存在严重损坏。"
                elif failed:
                    job.message = (
                        f"共 {len(candidates)} 个候选，{len(failed)} 个帧无法解码，已跳过。"
                    )
        except _AnalysisCanceled:
            return
        except AnalysisError as exc:
            with job.lock:
                if generation != job.analysis_generation:
                    return
                job.status = "error"
                job.message = str(exc)
                job.progress_stage = "失败"
        except Exception as exc:  # 单个任务失败不影响其他任务
            with job.lock:
                if generation != job.analysis_generation:
                    return
                job.status = "error"
                job.message = f"分析发生未预期错误：{exc}"
                job.progress_stage = "失败"

    # ------------------------------------------------------------------ 参数与规划

    def _validate_range(self, job: Job, start: float, end: float) -> None:
        if start < 0 or end < 0:
            raise AnalysisError("时间范围不能为负数。")
        if start >= end:
            raise AnalysisError("时间范围的起点必须早于终点。")
        if start > job.duration + 0.05:
            raise AnalysisError(
                f"起点 {start:.3f}s 超出视频时长 {job.duration:.3f}s。"
            )

    def _plan_requests(self, job: Job, params: dict) -> list[tuple[float, str]]:
        """根据策略生成 (请求时间, 来源) 列表，时间落在裁剪后的范围内。"""
        mode = params.get("mode", "interval")
        max_frames = int(params.get("max_frames", 20))
        min_gap = float(params.get("min_gap", 0.5))
        start = float(params.get("start", 0.0))
        end = float(params.get("end", job.duration))
        end = min(end, job.duration)
        self._validate_range(job, start, end)
        if max_frames < 1:
            raise AnalysisError("最多帧数至少为 1。")
        if min_gap < 0:
            raise AnalysisError("最小间隔不能为负数。")

        range_frames = [
            f for f in job.frames if start - 1e-9 <= f.pts_time <= end + 1e-9
        ]
        if not range_frames:
            raise AnalysisError("所选时间范围内没有可解码的帧。")

        if mode == "interval":
            interval = float(params.get("interval", 1.0))
            if interval <= 0:
                raise AnalysisError("时间间隔必须大于 0。")
            requested_times: list[float] = []
            t = start
            # 以真实时间均匀取点，而不是帧序号均分，避免 VFR 下时间失真
            while t <= end + 1e-9 and len(requested_times) < max_frames * 4:
                requested_times.append(t)
                t += interval
            if not requested_times or requested_times[-1] < end - 1e-9:
                if len(requested_times) < max_frames * 4:
                    requested_times.append(end)
            requested = [(t, "interval") for t in requested_times]
        elif mode == "scene":
            sensitivity = int(params.get("sensitivity", 3))
            threshold = SENSITIVITY_THRESHOLDS.get(sensitivity, 0.25)
            self._set_progress(job, job.analysis_generation, 0.15, "检测画面切换")
            scene_times, stderr, code = run_scene_detect(
                job.source_path,
                self._stream_position(job.probe, job.stream_index),
                threshold,
                job.cancel_event,
                on_progress=lambda r: self._set_progress(
                    job, job.analysis_generation, 0.15 + 0.45 * r, "检测画面切换"
                ),
                total_duration=job.duration or None,
            )
            if code == -1:
                self._finalize_cancel(job, job.analysis_generation)
                raise _AnalysisCanceled()
            if code != 0:
                raise AnalysisError(
                    "场景检测失败：" + " ".join(stderr.splitlines()[-3:])[:400]
                )
            # run_scene_detect 只回传 pts_time：showinfo 的 n 是滤镜输出
            # 序号而非流内帧序号，流内位置统一在 _build_candidates 中按
            # 时间戳映射回 ffprobe 枚举的真实帧，不做任何序号假设。
            scene_times = [
                pts for pts in scene_times if start - 1e-9 <= pts <= end + 1e-9
            ]
            # 范围起点本身也作为一个候选，保证开头画面可见；
            # 它不是检测出的切换点，来源标记为 start 而非 scene。
            requested_times = [start]
            requested_times.extend(scene_times)
            requested = [
                (t, "start" if i == 0 else "scene")
                for i, t in enumerate(requested_times)
            ]
        else:
            raise AnalysisError(f"未知分析模式：{mode}")

        # 最小相邻间隔过滤（基于请求时间），再按最多帧数截断
        filtered = self._apply_gap_and_cap(requested, min_gap, max_frames)
        if not filtered:
            raise AnalysisError("当前参数下没有产生任何候选帧，请放宽条件。")
        return filtered

    @staticmethod
    def _apply_gap_and_cap(
        requested: list[tuple[float, str]], min_gap: float, max_frames: int
    ) -> list[tuple[float, str]]:
        ordered = sorted(requested, key=lambda x: x[0])
        kept: list[tuple[float, str]] = []
        for time_, source in ordered:
            if not kept or time_ - kept[-1][0] >= min_gap - 1e-9:
                kept.append((time_, source))
        if len(kept) <= max_frames:
            return kept
        # 超出上限时在时间轴上均匀抽样，保留首尾
        indexes = [
            round(i * (len(kept) - 1) / (max_frames - 1)) for i in range(max_frames)
        ] if max_frames > 1 else [0]
        chosen = []
        last_t = None
        for i in indexes:
            t, s = kept[i]
            if last_t is None or t - last_t >= -1e-9:
                chosen.append((t, s))
                last_t = t
        return chosen

    # ------------------------------------------------------------------ 候选与去重

    def _build_candidates(
        self,
        job: Job,
        generation: int,
        requested: list[tuple[float, str]],
    ) -> list[Candidate]:
        """把请求时间映射到最近真实帧；同一真实帧只保留一条候选。"""
        candidates: list[Candidate] = []
        seen: dict[int, Candidate] = {}
        for req_time, source in requested:
            frame = nearest_frame(job.frames, req_time)
            if frame is None:
                continue
            if frame.frame_index in seen:
                existing = seen[frame.frame_index]
                if abs(existing.requested_time - req_time) > 1e-6:
                    existing.merged_requests.append(req_time)
                continue
            cand = Candidate(
                id=uuid.uuid4().hex,
                frame_index=frame.frame_index,
                requested_time=req_time,
                actual_time=frame.pts_time,
                source=source,
            )
            seen[frame.frame_index] = cand
            candidates.append(cand)
        candidates.sort(key=lambda c: c.actual_time)
        return candidates

    def add_manual_candidate(self, job: Job, requested_time: float) -> Candidate:
        with job.lock:
            if job.status == "analyzing":
                raise AnalysisError("分析进行中，暂不能手动补加帧。")
            if requested_time < 0:
                raise AnalysisError("时间不能为负数。")
            if requested_time > job.duration + 0.05:
                raise AnalysisError(
                    f"请求时间 {requested_time:.3f}s 超出视频时长 "
                    f"{job.duration:.3f}s。"
                )
            frame = nearest_frame(job.frames, requested_time)
            if frame is None:
                raise AnalysisError("没有可用的帧。")
            existing_id = job.frame_index_to_candidate.get(frame.frame_index)
            if existing_id is not None:
                existing = job.candidates[existing_id]
                # 同一时间点/同一真实帧重复加入不产生多份截图
                if abs(existing.requested_time - requested_time) > 1e-6:
                    existing.merged_requests.append(requested_time)
                return existing

            cand = Candidate(
                id=uuid.uuid4().hex,
                frame_index=frame.frame_index,
                requested_time=requested_time,
                actual_time=frame.pts_time,
                source="manual",
            )
            self._extract_candidates(job, [cand])
            job.candidates[cand.id] = cand
            job.frame_index_to_candidate[cand.frame_index] = cand.id
            return cand

    def remove_candidate(self, job: Job, candidate_id: str) -> None:
        with job.lock:
            cand = job.candidates.pop(candidate_id, None)
            if cand is None:
                return
            job.frame_index_to_candidate.pop(cand.frame_index, None)
            if cand.image_path and os.path.exists(cand.image_path):
                try:
                    os.remove(cand.image_path)
                except OSError:
                    pass

    def set_selected(self, job: Job, candidate_id: str, selected: bool) -> None:
        with job.lock:
            cand = job.candidates.get(candidate_id)
            if cand is None:
                raise AnalysisError("候选帧不存在。")
            cand.selected = selected

    # ------------------------------------------------------------------ 帧提取

    def _extract_all(
        self, job: Job, generation: int, candidates: list[Candidate]
    ) -> None:
        unique = self._dedupe_for_extraction(candidates)
        total = max(1, len(unique))
        done = 0
        # 分块提取：单个 ffmpeg 进程处理一批帧，部分帧损坏时只影响当前块
        for chunk_start in range(0, len(unique), EXTRACT_CHUNK_SIZE):
            if self._is_canceled(job, generation):
                return
            chunk = unique[chunk_start : chunk_start + EXTRACT_CHUNK_SIZE]
            self._extract_chunk(job, generation, chunk)
            done += len(chunk)
            self._set_progress(
                job,
                generation,
                0.35 + 0.60 * (done / total),
                f"导出帧图 {done}/{total}",
            )

    @staticmethod
    def _dedupe_for_extraction(candidates: list[Candidate]) -> list[Candidate]:
        seen: dict[int, Candidate] = {}
        for cand in candidates:
            seen.setdefault(cand.frame_index, cand)
        return sorted(seen.values(), key=lambda c: c.frame_index)

    def _extract_candidates(self, job: Job, candidates: list[Candidate]) -> None:
        """同步提取（手动补加用），失败信息写入候选本身。"""
        unique = self._dedupe_for_extraction(candidates)
        for chunk_start in range(0, len(unique), EXTRACT_CHUNK_SIZE):
            chunk = unique[chunk_start : chunk_start + EXTRACT_CHUNK_SIZE]
            self._extract_chunk(job, job.analysis_generation, chunk)

    def _extract_chunk(
        self, job: Job, generation: int, chunk: list[Candidate]
    ) -> None:
        if not chunk:
            return
        # 输出名带 job_id 与代次前缀，多任务/多轮之间天然不覆盖
        tag = f"{job.id[:8]}_g{generation}"
        pattern = os.path.join(job.frames_dir, f"{tag}_%03d.jpg")
        indices = [c.frame_index for c in chunk]
        args = build_extract_cmd(
            job.source_path,
            self._stream_position(job.probe, job.stream_index),
            indices,
            pattern,
            job.rotation,
        )
        code, stderr = run_ffmpeg(
            args,
            job.cancel_event,
            total_duration=job.duration or None,
        )
        if code == -1:
            return  # 取消，交由上层收尾
        # ffmpeg 按 select 命中顺序从 1 开始编号输出
        for offset, cand in enumerate(chunk):
            out_path = os.path.join(
                job.frames_dir, f"{tag}_{offset + 1:03d}.jpg"
            )
            if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
                cand.image_path = out_path
                cand.image_ready = True
                cand.error = None
            else:
                cand.image_ready = False
                cand.error = "该帧无法解码或已损坏"
                job.warnings.append(
                    f"t={cand.actual_time:.3f}s 的帧提取失败"
                )
        # 非零退出但部分文件成功：保留成功部分，记录警告
        if code != 0 and not any(c.image_ready for c in chunk):
            tail = " ".join(stderr.splitlines()[-3:])[:300]
            for cand in chunk:
                cand.error = f"ffmpeg 提取失败：{tail}"

    # ------------------------------------------------------------------ 状态辅助

    def _is_canceled(self, job: Job, generation: int) -> bool:
        return (
            generation != job.analysis_generation
            or (job.cancel_event is not None and job.cancel_event.is_set())
        )

    def _set_progress(
        self, job: Job, generation: int, ratio: float, stage: str
    ) -> None:
        with job.lock:
            if generation != job.analysis_generation:
                return
            job.progress = max(job.progress, min(ratio, 0.999))
            job.progress_stage = stage

    def _finalize_cancel(self, job: Job, generation: int) -> None:
        with job.lock:
            if generation != job.analysis_generation:
                return
            job.status = "canceled"
            job.progress_stage = "已取消"
            job.message = "已取消本轮分析，已生成的部分候选不会保留。"
            self._clear_candidates_locked(job)

    def _clear_candidates_locked(self, job: Job) -> None:
        """清空候选并删除该任务帧目录中的提取产物（不动原视频）。"""
        job.candidates.clear()
        job.frame_index_to_candidate.clear()
        if os.path.isdir(job.frames_dir):
            for name in os.listdir(job.frames_dir):
                try:
                    os.remove(os.path.join(job.frames_dir, name))
                except OSError:
                    pass

    def shutdown(self) -> None:
        for job in list(self.jobs.values()):
            if job.cancel_event is not None:
                job.cancel_event.set()
        self._pool.shutdown(wait=False)
