"""导出任务：后台线程跑 ffmpeg，主线程轮询进度。"""
from __future__ import annotations

import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import ffmpeg as ff
from .keyframes import build_x_expression, crop_size, normalize_keyframes


@dataclass
class Job:
    id: str
    dst: str
    status: str = "running"          # running / done / error
    progress: float = 0.0            # 0~1
    error: str = ""
    cmd: list[str] = field(default_factory=list)


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def get_job(job_id: str) -> Job | None:
    with _lock:
        return _jobs.get(job_id)


def start_export(project: dict, output: str) -> str:
    """按 project 启动导出，返回 job id。失败信息只写入 job，不修改 project。"""
    job_id = uuid.uuid4().hex[:12]
    job = Job(id=job_id, dst=output)
    with _lock:
        _jobs[job_id] = job

    thread = threading.Thread(
        target=_run_export, args=(job, dict(project), output), daemon=True
    )
    thread.start()
    return job_id


def _run_export(job: Job, project: dict, output: str) -> None:
    try:
        info = ff.probe(project["src"])
        # 导出以源文件的显示方向为准（ffmpeg 默认 autorotate 先烤正）
        dw, dh = info.display_width, info.display_height
        crop_w, crop_h = crop_size(dw, dh)
        kfs = normalize_keyframes(
            project["keyframes"], info.duration, dw, crop_w
        )
        easing = project.get("easing", "smoothstep")
        x_expr = build_x_expression(kfs, dw, crop_w, easing)
        cmd = ff.build_export_command(
            project["src"], output, crop_w, crop_h, x_expr, info.has_audio
        )
        job.cmd = cmd

        Path(output).parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            done = ff.parse_progress(line)
            if done is not None:
                job.progress = max(0.0, min(0.99, done / max(info.duration, 1e-6)))
        stderr = proc.stderr.read() if proc.stderr else ""
        code = proc.wait()
        if code != 0:
            tail = "\n".join(stderr.strip().splitlines()[-8:])
            raise ff.FFmpegError(f"ffmpeg 退出码 {code}：\n{tail}")
        if not Path(output).exists() or Path(output).stat().st_size == 0:
            raise ff.FFmpegError("导出结束但输出文件缺失或为空")
        job.progress = 1.0
        job.status = "done"
    except Exception as exc:  # 全部错误回传，原 project 不动
        job.status = "error"
        job.error = str(exc)
