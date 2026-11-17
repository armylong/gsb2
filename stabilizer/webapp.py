"""本地网页服务: 上传分析、参数重算、预览、导出与输出复核。

所有任务产物放在 workspace/tasks 下, 纯本地运行, 无外部服务。
"""
from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path

from flask import (Flask, abort, jsonify, request, send_from_directory,
                   send_file)

from . import geometry as geom
from . import media, motion, pipeline, samplegen

BASE_DIR = Path(__file__).resolve().parent
WORKSPACE = BASE_DIR.parent / "workspace"
TASKS_DIR = WORKSPACE / "tasks"
SAMPLE_DIR = WORKSPACE / "sample"
TASKS_DIR.mkdir(parents=True, exist_ok=True)

MAX_JOBS = 20
app = Flask(__name__, static_folder="static", static_url_path="")
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_render_locks: dict[str, threading.Lock] = {}
_render_locks_guard = threading.Lock()


def _render_lock(task_id: str) -> threading.Lock:
    with _render_locks_guard:
        lk = _render_locks.get(task_id)
        if lk is None:
            lk = threading.Lock()
            _render_locks[task_id] = lk
        return lk


def _job(task_id: str) -> dict:
    job = _jobs.get(task_id)
    if job is None or not (TASKS_DIR / task_id).exists():
        abort(404, "任务不存在或已被清理")
    return job


def _run_job(task_id: str, fn, *args) -> None:
    job = _jobs[task_id]
    try:
        result = fn(*args)
        with _jobs_lock:
            job["status"] = "done"
            job["result"] = result
    except Exception as exc:  # noqa: BLE001 - 后台线程需把异常送回前端
        with _jobs_lock:
            job["status"] = "error"
            job["error"] = f"{type(exc).__name__}: {exc}"[:500]


def _spawn(task_id: str, fn, *args) -> None:
    threading.Thread(target=_run_job, args=(task_id, fn, *args),
                     daemon=True).start()


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        abort(400, "缺少 file 字段")
    if Path(f.filename).name != f.filename or "/" in f.filename \
            or ".." in f.filename:
        abort(400, "非法文件名")
    if Path(f.filename).suffix.lower() != ".mp4":
        abort(400, "仅支持 .mp4 文件")
    task_id = uuid.uuid4().hex[:12]
    d = TASKS_DIR / task_id
    d.mkdir(parents=True)
    src = d / "source.mp4"
    f.save(src)
    # 先同步校验, 约束不满足直接报错并清理
    try:
        media.probe(src)
    except media.MediaError as exc:
        import shutil
        shutil.rmtree(d, ignore_errors=True)
        abort(400, str(exc))
    with _jobs_lock:
        if len(_jobs) > MAX_JOBS:
            oldest = next(iter(_jobs))
            _jobs.pop(oldest)
        _jobs[task_id] = {"status": "running", "dir": str(d), "kind": "analyze"}
    _spawn(task_id, pipeline.analyze_video, str(src))
    return jsonify({"task_id": task_id})


@app.post("/api/sample")
def make_sample():
    task_id = uuid.uuid4().hex[:12]
    d = TASKS_DIR / task_id
    d.mkdir(parents=True)

    def build():
        info = samplegen.generate(d)
        return pipeline.analyze_video(info["video"])

    with _jobs_lock:
        _jobs[task_id] = {"status": "running", "dir": str(d), "kind": "analyze"}
    _spawn(task_id, build)
    return jsonify({"task_id": task_id})


@app.get("/api/job/<task_id>")
def job_status(task_id: str):
    job = _job(task_id)
    with _jobs_lock:
        state = {"status": job["status"], "kind": job.get("kind")}
        if "error" in job:
            state["error"] = job["error"]
        if job["status"] == "done" and isinstance(job.get("result"),
                                                   pipeline.AnalysisCache):
            cache: pipeline.AnalysisCache = job["result"]
            payload = cache.to_payload()
            payload["status"] = "done"
            payload["task_id"] = task_id
            return jsonify(payload)
    return jsonify(state)


def _get_cache(task_id: str) -> pipeline.AnalysisCache:
    job = _job(task_id)
    if job["status"] != "done" or not isinstance(job.get("result"),
                                                  pipeline.AnalysisCache):
        abort(409, "分析尚未完成")
    return job["result"]


def _geometry_payload(cache: pipeline.AnalysisCache, geo: geom.Geometry,
                      cuts: list[int], sigma: float, version: int) -> dict:
    info = cache.info
    starts = [0] + cuts
    shot_of = np_shot_of(starts, info.frame_count)
    frames = []
    pr, ps = geo.params_raw, geo.params_smooth
    for i in range(info.frame_count):
        frames.append({
            "frame": i,
            "time": round(i / info.fps, 4),
            "shot": int(shot_of[i]),
            "raw": [round(pr["tx"][i], 3), round(pr["ty"][i], 3),
                    round(pr["angle"][i], 4)],
            "smooth": [round(ps["tx"][i], 3), round(ps["ty"][i], 3),
                       round(ps["angle"][i], 4)],
            "valid_quad": geo.valid_quads[i].round(2).tolist(),
            "sample_quad": geo.sample_boxes[i].round(2).tolist(),
        })
    shots = []
    for k, s in enumerate(starts):
        e = (cuts + [info.frame_count])[k]
        shots.append({
            "index": k, "start_frame": s, "end_frame_exclusive": e,
            "uniform_zoom": round(float(geo.shot_zoom[k]), 5),
            "safe_crop_rect": [round(float(v), 2)
                               for v in geo.shot_safe_rects[k]],
            "retained_area_ratio": round(float(geo.retained_ratio[k]), 4),
            "below_warn": bool(geo.retained_ratio[k]
                               < geom.RETAIN_WARN_RATIO),
            "kept_px": [round(info.width / geo.shot_zoom[k], 1),
                        round(info.height / geo.shot_zoom[k], 1)],
        })
    return {
        "version": version,
        "sigma": sigma,
        "cuts": cuts,
        "fps": info.fps,
        "frame_count": info.frame_count,
        "width": info.width,
        "height": info.height,
        "has_audio": info.has_audio,
        "warn_threshold": geom.RETAIN_WARN_RATIO,
        "shots": shots,
        "frames": frames,
        "detection": {
            "auto_cuts": cache.motions.auto_cuts,
            "gray_diffs": cache.motions.gray_diffs.round(3).tolist(),
            "inlier_ratios": cache.motions.inlier_ratios.round(3).tolist(),
        },
    }


def np_shot_of(starts: list[int], n: int):
    import numpy as np
    out = np.zeros(n, dtype=int)
    for k, s in enumerate(starts):
        out[s:] = k
    return out


@app.post("/api/compute/<task_id>")
def compute(task_id: str):
    cache = _get_cache(task_id)
    data = request.get_json(force=True)
    try:
        sigma = float(data.get("sigma", 8))
        cuts = motion.validate_cuts(
            [int(c) for c in data.get("cuts", cache.motions.auto_cuts)],
            cache.info.frame_count,
        )
    except (TypeError, ValueError):
        abort(400, "参数格式错误")
    if not 0.5 <= sigma <= 60:
        abort(400, "sigma 需在 0.5~60 帧之间")
    _, geo = pipeline.compute(cache, cuts, sigma)
    version = int(data.get("version", 0)) + 1
    payload = _geometry_payload(cache, geo, cuts, sigma, version)
    # 触发一次新预览渲染, 旧预览文件将被同名覆盖
    d = Path(job_dir(task_id))
    job = _jobs[task_id]
    with _jobs_lock:
        job["preview"] = {"status": "running", "version": version}
    threading.Thread(
        target=_render_preview,
        args=(task_id, cache, geo, cuts, d / "preview.mp4", version),
        daemon=True,
    ).start()
    return jsonify(payload)


def job_dir(task_id: str) -> str:
    return _job(task_id)["dir"]


def _render_preview(task_id: str, cache: pipeline.AnalysisCache,
                    geo: geom.Geometry, cuts: list[int], out: Path,
                    version: int) -> None:
    # 同一任务串行渲染; 渲染完若已有更新版本则丢弃本次结果, 不覆盖新预览
    with _render_lock(task_id):
        with _jobs_lock:
            queued = _jobs[task_id].get("preview", {}).get("version", 0)
        if queued > version:
            return
        try:
            tmp = out.with_name("preview.tmp.mp4")
            pipeline.render_video(cache, geo, cuts, tmp, preview=True,
                                  draw_overlay=True)
            with _jobs_lock:
                latest = _jobs[task_id].get("preview", {}).get("version", 0)
            if latest > version:
                tmp.unlink(missing_ok=True)
                return
            tmp.replace(out)
            with _jobs_lock:
                _jobs[task_id]["preview"] = {"status": "done",
                                             "version": version}
        except Exception as exc:  # noqa: BLE001
            with _jobs_lock:
                _jobs[task_id]["preview"] = {
                    "status": "error", "version": version,
                    "error": str(exc)[:300]}


@app.get("/api/preview/<task_id>")
def preview_status(task_id: str):
    job = _job(task_id)
    with _jobs_lock:
        state = dict(job.get("preview", {"status": "idle"}))
    state["task_id"] = task_id
    return jsonify(state)


@app.get("/video/<task_id>/<kind>")
def video_file(task_id: str, kind: str):
    d = Path(job_dir(task_id))
    if kind == "source":
        # 上传任务存 source.mp4, 样例任务存 sample_input.mp4
        name = "source.mp4" if (d / "source.mp4").exists() \
            else "sample_input.mp4"
    else:
        name = {"preview": "preview.mp4", "output": "output.mp4"}.get(kind)
    if name is None:
        abort(404)
    p = d / name
    if not p.exists():
        abort(404, "视频尚未生成")
    return send_file(str(p), mimetype="video/mp4", conditional=True)


@app.post("/api/export/<task_id>")
def export(task_id: str):
    cache = _get_cache(task_id)
    data = request.get_json(force=True)
    try:
        sigma = float(data.get("sigma", 8))
        cuts = motion.validate_cuts(
            [int(c) for c in data.get("cuts", cache.motions.auto_cuts)],
            cache.info.frame_count,
        )
    except (TypeError, ValueError):
        abort(400, "参数格式错误")
    d = Path(job_dir(task_id))
    with _jobs_lock:
        _jobs[task_id]["export"] = {"status": "running"}
    threading.Thread(target=_do_export,
                     args=(task_id, cache, cuts, sigma, d), daemon=True).start()
    return jsonify({"status": "started"})


def _do_export(task_id: str, cache: pipeline.AnalysisCache, cuts: list[int],
               sigma: float, d: Path) -> None:
    try:
        # 重新计算, 确保导出与当前参数严格一致
        _, geo = pipeline.compute(cache, cuts, sigma)
        out = d / "output.mp4"
        pipeline.render_video(cache, geo, cuts, out, preview=False,
                              draw_overlay=False)
        sidecar = pipeline.build_sidecar(cache, geo, cuts, sigma, "output.mp4")
        sidecar_path = d / "output.sidecar.json"
        pipeline.save_sidecar(sidecar, sidecar_path)
        # 同步写一份检测信息, 供重开时展示
        (d / "analysis.json").write_text(
            json.dumps(cache.to_payload(), ensure_ascii=False),
            encoding="utf-8",
        )
        with _jobs_lock:
            _jobs[task_id]["export"] = {"status": "done"}
    except Exception as exc:  # noqa: BLE001
        with _jobs_lock:
            _jobs[task_id]["export"] = {"status": "error",
                                        "error": str(exc)[:300]}


@app.get("/api/export/<task_id>/status")
def export_status(task_id: str):
    job = _job(task_id)
    with _jobs_lock:
        state = dict(job.get("export", {"status": "idle"}))
    return jsonify(state)


@app.get("/api/sidecar/<task_id>")
def sidecar(task_id: str):
    p = Path(job_dir(task_id)) / "output.sidecar.json"
    if not p.exists():
        abort(404, "尚未导出")
    return send_file(str(p), mimetype="application/json", as_attachment=True)


@app.post("/api/reopen")
def reopen():
    """重新打开已导出的 output.mp4 + sidecar 做核对。"""
    vf = request.files.get("video")
    sf = request.files.get("sidecar")
    if vf is None or sf is None:
        abort(400, "需要 video 与 sidecar 两个文件")
    try:
        meta = json.loads(sf.read().decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        abort(400, "sidecar 不是合法 JSON")
    task_id = uuid.uuid4().hex[:12]
    d = TASKS_DIR / task_id
    d.mkdir(parents=True)
    vf.save(d / "output.mp4")
    (d / "output.sidecar.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    with _jobs_lock:
        _jobs[task_id] = {"status": "done", "dir": str(d), "kind": "reopen",
                          "reopen_meta": meta}
    return jsonify({"task_id": task_id, "sidecar": meta})


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="本地视频防抖工具网页服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
