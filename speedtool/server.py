"""本地网页服务：导入/样例、分段校验、双向时间查询、渲染预览、导出。"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel

from . import render as render_mod
from . import sample as sample_mod
from .segments import (MAX_SEGMENTS, Segment, SegmentError, build_plan,
                       locate, total_duration)

BASE_DIR = Path(__file__).resolve().parent.parent
WORKSPACE = BASE_DIR / "workspace"
UPLOAD_DIR = WORKSPACE / "uploads"
RENDER_DIR = WORKSPACE / "renders"
SAMPLE_PATH = WORKSPACE / "sample" / "sample.mp4"
STATIC_DIR = Path(__file__).resolve().parent / "static"

MAX_SOURCE_DURATION = 20.0 + 0.05  # 允许 20 秒整的成片（含微小浮点余量）

for d in (UPLOAD_DIR, RENDER_DIR, SAMPLE_PATH.parent):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="单视频分段变速工具")

# video_id -> {"path": Path, "info": dict}
VIDEOS: dict[str, dict] = {}
# render_id -> {"path": Path, "plan": list[PlanRow], "video_id": str}
RENDERS: dict[str, dict] = {}


class SegmentIn(BaseModel):
    start: float
    end: float
    speed: float


class PlanRequest(BaseModel):
    video_id: str
    segments: list[SegmentIn]


class MapRequest(BaseModel):
    video_id: str
    segments: list[SegmentIn]
    src_time: float | None = None
    out_time: float | None = None


def _get_video(video_id: str) -> dict:
    v = VIDEOS.get(video_id)
    if v is None:
        raise HTTPException(404, "视频不存在或已过期，请重新导入")
    return v


def _build_plan_or_400(req: PlanRequest | MapRequest):
    video = _get_video(req.video_id)
    segs = [Segment(s.start, s.end, s.speed) for s in req.segments]
    try:
        plan = build_plan(segs, video["info"]["duration"])
    except SegmentError as e:
        raise HTTPException(400, str(e))
    return video, plan


def _register_video(path: Path) -> dict:
    try:
        info = render_mod.probe(path)
    except Exception as e:
        path.unlink(missing_ok=True)
        raise HTTPException(400, f"无法读取视频：{e}")
    if not info["has_audio"]:
        path.unlink(missing_ok=True)
        raise HTTPException(400, "视频没有音频流，本工具要求导入带音频的 mp4")
    if info["duration"] > MAX_SOURCE_DURATION:
        path.unlink(missing_ok=True)
        raise HTTPException(
            400, f"视频时长 {info['duration']:.2f}s 超过 20 秒上限，请裁剪后再导入")
    video_id = uuid.uuid4().hex[:12]
    VIDEOS[video_id] = {"path": path, "info": info}
    return {"video_id": video_id, "url": f"/media/video/{video_id}", "info": info}


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.post("/api/sample")
def make_sample(force: bool = False):
    """生成（或复用）样例视频并导入。"""
    if force or not SAMPLE_PATH.exists():
        sample_mod.generate_sample(SAMPLE_PATH)
    return _register_video(SAMPLE_PATH)


@app.post("/api/upload")
async def upload(file: UploadFile):
    suffix = Path(file.filename or "video.mp4").suffix.lower() or ".mp4"
    path = UPLOAD_DIR / f"{uuid.uuid4().hex[:12]}{suffix}"
    path.write_bytes(await file.read())
    return _register_video(path)


@app.post("/api/plan")
def plan(req: PlanRequest):
    _, p = _build_plan_or_400(req)
    return {
        "rows": [r.as_dict() for r in p],
        "total": total_duration(p),
        "max_segments": MAX_SEGMENTS,
    }


@app.post("/api/map")
def time_map(req: MapRequest):
    """双向查询：传 src_time 或 out_time 之一。"""
    _, p = _build_plan_or_400(req)
    try:
        if req.src_time is not None:
            idx, out = locate(p, req.src_time, "src")
            return {"side": "src", "segment": idx, "src_time": req.src_time, "out_time": out}
        if req.out_time is not None:
            idx, src = locate(p, req.out_time, "out")
            return {"side": "out", "segment": idx, "src_time": src, "out_time": req.out_time}
    except SegmentError as e:
        raise HTTPException(400, str(e))
    raise HTTPException(400, "请提供 src_time 或 out_time")


@app.post("/api/render")
def do_render(req: PlanRequest):
    video, p = _build_plan_or_400(req)
    render_id = uuid.uuid4().hex[:12]
    out_path = RENDER_DIR / f"{render_id}.mp4"
    try:
        info = render_mod.render(video["path"], p, out_path)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    RENDERS[render_id] = {"path": out_path, "plan": p, "video_id": req.video_id}
    return {
        "render_id": render_id,
        "url": f"/media/render/{render_id}",
        "export_url": f"/api/export/{render_id}",
        "rows": [r.as_dict() for r in p],
        "total": total_duration(p),
        "output_info": info,
    }


@app.get("/api/export/{render_id}")
def export(render_id: str):
    r = RENDERS.get(render_id)
    if r is None:
        raise HTTPException(404, "渲染结果不存在，请重新生成预览")
    return FileResponse(r["path"], media_type="video/mp4",
                        filename="segment_speed_export.mp4")


_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


def _range_response(path: Path, range_header: str | None) -> Response:
    """支持 HTTP Range 的视频响应，拖动进度条必需。"""
    size = path.stat().st_size
    if not range_header:
        return FileResponse(path, media_type="video/mp4")
    m = _RANGE_RE.match(range_header.strip())
    if not m:
        return FileResponse(path, media_type="video/mp4")
    start_s, end_s = m.groups()
    start = int(start_s) if start_s else 0
    end = int(end_s) if end_s else size - 1
    end = min(end, size - 1)
    if start > end:
        return Response(status_code=416)
    with open(path, "rb") as f:
        f.seek(start)
        data = f.read(end - start + 1)
    return Response(
        data, status_code=206, media_type="video/mp4",
        headers={
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(len(data)),
        })


@app.get("/media/video/{video_id}")
def media_video(video_id: str, request: Request):
    v = _get_video(video_id)
    return _range_response(v["path"], request.headers.get("range"))


@app.get("/media/render/{render_id}")
def media_render(render_id: str, request: Request):
    r = RENDERS.get(render_id)
    if r is None:
        raise HTTPException(404, "渲染结果不存在，请重新生成预览")
    return _range_response(r["path"], request.headers.get("range"))
