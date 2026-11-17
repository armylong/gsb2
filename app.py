"""本地网页工具:两套 H.264 配置转码 + 分段码率/关键帧/画面对比。

启动: python app.py  然后打开 http://127.0.0.1:8080
"""
import json
import os
import re
import shutil
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory, Response

import core

BASE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(BASE, "work")
INPUT = os.path.join(WORK, "current_input.mp4")
SAMPLE = os.path.join(WORK, "sample.mp4")
os.makedirs(WORK, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")

RUN_RE = re.compile(r"^[\w-]+$")


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if not f:
        return jsonify(ok=False, error="未选择文件")
    f.save(INPUT)
    try:
        info = core.probe_input(INPUT)
    except Exception as e:
        return jsonify(ok=False, error="无法解析文件: %s" % e)
    problems = core.validate_input(info)
    return jsonify(ok=not problems, problems=problems, info=info)


@app.post("/api/sample")
def sample():
    try:
        core.gen_sample(SAMPLE)
        shutil.copy(SAMPLE, INPUT)
        info = core.probe_input(INPUT)
    except Exception as e:
        return jsonify(ok=False, error=str(e))
    return jsonify(ok=True, info=info)


@app.post("/api/run")
def run():
    if not os.path.exists(INPUT):
        return jsonify(ok=False, error="请先上传或生成输入视频")
    d = request.get_json(force=True)
    window = float(d.get("window", 1))
    target_mb = float(d.get("target_mb", 0))
    audio_kbps = int(d.get("audio_kbps", 96))
    cfgs = d.get("configs") or {}

    run_id = time.strftime("%Y%m%d_%H%M%S_") + uuid.uuid4().hex[:6]
    rdir = os.path.join(WORK, run_id)
    os.makedirs(rdir)
    src = os.path.join(rdir, "src.mp4")
    shutil.copy(INPUT, src)  # 本轮快照,保证统计/画面/播放同属一轮

    outs = {}
    for key in ("a", "b"):
        outp = os.path.join(rdir, key + ".mp4")
        try:
            core.transcode(src, outp, cfgs[key], audio_kbps)
        except Exception as e:
            shutil.rmtree(rdir, ignore_errors=True)  # 失败即清理,不留半成品
            return jsonify(ok=False, failed=key,
                           error="配置 %s 转码失败: %s" % (key.upper(), e))
        outs[key] = outp

    result = {"ok": True, "run": run_id, "window": window,
              "target_bytes": int(target_mb * 1024 * 1024), "outputs": {}}
    try:
        for key in ("a", "b"):
            an = core.analyze(outs[key], window)
            an["url"] = "/media/%s/%s.mp4" % (run_id, key)
            result["outputs"][key] = an
        src_an = core.analyze(src, window)
        result["src"] = {"fps": src_an["fps"], "duration": src_an["duration"]}
    except Exception as e:
        shutil.rmtree(rdir, ignore_errors=True)
        return jsonify(ok=False, error="分析输出失败: %s" % e)

    with open(os.path.join(rdir, "analysis.json"), "w") as f:
        json.dump(result, f)
    return jsonify(result)


@app.get("/media/<run>/<name>")
def media(run, name):
    if not RUN_RE.match(run) or name not in ("a.mp4", "b.mp4", "src.mp4"):
        return "not found", 404
    path = os.path.join(WORK, run, name)
    if not os.path.exists(path):
        return "not found", 404
    return send_from_directory(os.path.join(WORK, run), name)


@app.get("/api/frame")
def frame():
    run = request.args.get("run", "")
    which = request.args.get("which", "")
    t = float(request.args.get("t", 0))
    if not RUN_RE.match(run) or which not in ("a", "b", "src"):
        return "bad request", 400
    path = os.path.join(WORK, run, {"a": "a.mp4", "b": "b.mp4", "src": "src.mp4"}[which])
    if not os.path.exists(path):
        return "not found", 404
    try:
        jpeg, pts = core.extract_frame_jpeg(path, t)
    except Exception as e:
        return str(e), 500
    return Response(jpeg, mimetype="image/jpeg",
                    headers={"X-Frame-Pts": "%.4f" % pts,
                             "Access-Control-Expose-Headers": "X-Frame-Pts"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8080, debug=False)
