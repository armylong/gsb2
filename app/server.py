"""本地网页后端:加载视频、框选区域、跟踪计算、人工修正、导出。

启动: python -m app.server  (默认 http://127.0.0.1:7860)
"""
from __future__ import annotations

import os
import threading
import time

import cv2
from flask import Flask, jsonify, request, send_file, send_from_directory

from . import video_io
from .tracker import MaskTrack

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(BASE, "work")
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

app = Flask(__name__, static_folder=STATIC)


class Session:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.video_path = None
        self.info = None
        self.frames_dir = None
        self.track = None
        self.compute_version = 0
        self.compute_state = "idle"  # idle | computing | done | error
        self.compute_error = None


S = Session()


def _get_gray_factory(frames_dir):
    cache = {}

    def get_gray(idx):
        g = cache.get(idx)
        if g is None:
            img = cv2.imread(os.path.join(frames_dir, f"f{idx:06d}.jpg"))
            if img is None:
                raise RuntimeError(f"无法读取第 {idx} 帧")
            g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            if len(cache) > 64:
                cache.clear()
            cache[idx] = g
        return g

    return get_gray


def _start_compute():
    with S.lock:
        S.compute_version += 1
        version = S.compute_version
        S.compute_state = "computing"
        S.compute_error = None

    def run():
        try:
            with S.lock:
                track = S.track
            track.compute()
            with S.lock:
                if S.compute_version == version:
                    S.compute_state = "done"
        except Exception as e:  # noqa: BLE001
            with S.lock:
                S.compute_state = "error"
                S.compute_error = str(e)

    threading.Thread(target=run, daemon=True).start()


@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.post("/api/load")
def load():
    path = (request.json or {}).get("path", "").strip()
    info = video_io.probe(path)
    if not info["ok"]:
        return jsonify(info), 400
    S.reset()
    S.video_path = path
    S.info = info
    S.frames_dir = os.path.join(WORK, f"session_{int(time.time())}", "frames")
    try:
        n = video_io.extract_frames(path, S.frames_dir, expected=info["frames"])
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "errors": [str(e)]}), 400
    info["frames"] = n
    S.track = MaskTrack(_get_gray_factory(S.frames_dir), n)
    return jsonify(info)


@app.post("/api/sample")
def sample():
    from .sample_gen import generate
    try:
        return jsonify(generate(os.path.join(BASE, "samples")))
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500


@app.route("/api/frame/<int:idx>")
def frame(idx):
    if S.frames_dir is None:
        return "未加载视频", 400
    p = os.path.join(S.frames_dir, f"f{idx:06d}.jpg")
    if not os.path.isfile(p):
        return "帧不存在", 404
    return send_file(p, mimetype="image/jpeg")


@app.post("/api/region")
def set_region():
    if S.track is None:
        return jsonify({"error": "未加载视频"}), 400
    d = request.json or {}
    try:
        S.track.set_region(d["start"], d["end"], d["frame"],
                           (d["x"], d["y"], d["w"], d["h"]))
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    _start_compute()
    return jsonify({"ok": True})


@app.post("/api/keyframe")
def add_keyframe():
    if S.track is None or not S.track.keyframes:
        return jsonify({"error": "尚未设置遮挡区域"}), 400
    d = request.json or {}
    try:
        S.track.add_keyframe(d["frame"], (d["x"], d["y"], d["w"], d["h"]))
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    _start_compute()
    return jsonify({"ok": True})


@app.delete("/api/keyframe/<int:idx>")
def del_keyframe(idx):
    if S.track is None:
        return jsonify({"error": "未加载视频"}), 400
    if not S.track.remove_keyframe(idx):
        return jsonify({"error": "该帧没有可删除的修正(至少保留初始框选)"}), 400
    _start_compute()
    return jsonify({"ok": True})


@app.post("/api/reset")
def reset_region():
    if S.track is not None:
        S.track.clear()
    with S.lock:
        S.compute_state = "idle"
    return jsonify({"ok": True})


@app.get("/api/status")
def status():
    with S.lock:
        return jsonify({"state": S.compute_state, "error": S.compute_error,
                        "version": S.compute_version})


@app.get("/api/boxes")
def boxes():
    if S.track is None:
        return jsonify({"error": "未加载视频"}), 400
    t = S.track
    return jsonify({
        "start": t.start, "end": t.end,
        "keyframes": sorted(t.keyframes),
        "low_intervals": t.low_intervals(),
        "boxes": {str(f): r for f, r in t.results.items()},
    })


@app.post("/api/export")
def export():
    if S.track is None or not S.track.results:
        return jsonify({"error": "尚未计算跟踪结果"}), 400
    with S.lock:
        if S.compute_state != "done":
            return jsonify({"error": "跟踪计算尚未完成,请稍候"}), 400
    d = request.json or {}
    out = d.get("out") or os.path.join(
        BASE, "exports", f"masked_{int(time.time())}.mp4")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    t = S.track
    low = t.low_intervals()
    if low and not d.get("confirm_low"):
        return jsonify({"need_confirm": True, "low_intervals": low}), 200
    boxes = {f: (r["x"], r["y"], r["w"], r["h"]) for f, r in t.results.items()}
    try:
        res = video_io.export_masked(S.video_path, boxes, (t.start, t.end),
                                     out, S.info["fps_str"])
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500
    res["low_intervals"] = low
    return jsonify(res)


if __name__ == "__main__":
    os.makedirs(WORK, exist_ok=True)
    app.run(host="127.0.0.1", port=7860, threaded=True)
