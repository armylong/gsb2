"""本地网页工具:多声道 WAV -> 立体声 路由/极性/延时 验证。

启动: python3 app.py  然后浏览器打开 http://127.0.0.1:8048/
"""
import json
import os
import time

import numpy as np
from flask import Flask, jsonify, request, send_from_directory

import dsp

BASE = os.path.dirname(os.path.abspath(__file__))
EXPORT_DIR = os.path.join(BASE, "exports")
TEST_DIR = os.path.join(BASE, "test_tones")
CONFIG_DIR = os.path.join(BASE, "configs")
os.makedirs(EXPORT_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", static_url_path="/static")

# 本地单人工具,保存当前加载的样例即可
STATE = {"path": None, "samples": None}


def envelope(x, points=1200):
    """波形显示用的 min/max 包络。"""
    n = len(x)
    if n == 0:
        return [], []
    if n <= points:
        v = x.tolist()
        return v, v
    edges = np.linspace(0, n, points + 1).astype(int)
    mn, mx = [], []
    for i in range(points):
        seg = x[edges[i]:edges[i + 1]]
        mn.append(float(seg.min()))
        mx.append(float(seg.max()))
    return mn, mx


def file_info(path):
    samples, sr = dsp.read_wav(path)
    n, c = samples.shape
    chans = []
    for i in range(c):
        mn, mx = envelope(samples[:, i])
        chans.append(
            {
                "index": i + 1,  # 按文件中的实际顺序编号,不猜测方位含义
                "min": mn,
                "max": mx,
                "peak": float(np.abs(samples[:, i]).max()),
            }
        )
    return samples, {
        "name": os.path.basename(path),
        "sampleRate": sr,
        "channels": c,
        "samples": n,
        "seconds": n / sr,
        "channelData": chans,
    }


def source_reference(samples):
    """原始输入试听参考:声道1->L, 2->R, 3->L ... 等增益,自动保护防削波。"""
    n, c = samples.shape
    out = np.zeros((n, 2))
    for i in range(c):
        out[:, i % 2] += samples[:, i]
    peak = float(np.abs(out).max()) if n else 0.0
    if peak > dsp.FULL_SCALE:
        out *= dsp.FULL_SCALE / peak
    return out


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/exports/<path:fname>")
def exports(fname):
    return send_from_directory(EXPORT_DIR, fname)


@app.route("/api/testfiles")
def testfiles():
    files = []
    if os.path.isdir(TEST_DIR):
        files = sorted(f for f in os.listdir(TEST_DIR) if f.lower().endswith(".wav"))
    return jsonify({"files": files})


@app.route("/api/presets")
def presets():
    files = []
    if os.path.isdir(CONFIG_DIR):
        files = sorted(f for f in os.listdir(CONFIG_DIR) if f.endswith(".json"))
    return jsonify({"files": files})


@app.route("/api/preset/<path:name>")
def preset(name):
    path = os.path.join(CONFIG_DIR, os.path.basename(name))
    if not os.path.isfile(path):
        return jsonify({"error": "预设不存在"}), 404
    with open(path, encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/api/load", methods=["POST"])
def load():
    if "file" in request.files:
        path = os.path.join(EXPORT_DIR, "_upload.wav")
        request.files["file"].save(path)
    else:
        body = request.get_json(silent=True) or {}
        name = os.path.basename(body.get("name", ""))
        path = os.path.join(TEST_DIR, name)
        if not name or not os.path.isfile(path):
            return jsonify({"error": "文件不存在"}), 404
    try:
        samples, info = file_info(path)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    STATE["path"] = path
    STATE["samples"] = samples
    return jsonify(info)


def _render_audition(samples, channels, protect):
    """处理结果 / 原始参考 / 单声道合听 三个试听文件,整段确定性渲染。"""
    out, info = dsp.process(samples, channels, protect)
    dsp.write_wav(os.path.join(EXPORT_DIR, "_aud_processed.wav"), out)
    dsp.write_wav(os.path.join(EXPORT_DIR, "_aud_source.wav"), source_reference(samples))
    mono = (out[:, 0] + out[:, 1]) / 2.0
    dsp.write_wav(
        os.path.join(EXPORT_DIR, "_aud_mono.wav"), np.stack([mono, mono], axis=1)
    )
    stats = dict(info)
    stats["corr"] = dsp.correlation(out[:, 0], out[:, 1])
    stats["mono_peak"] = float(np.abs(mono).max()) if len(mono) else 0.0
    return stats


@app.route("/api/process", methods=["POST"])
def process_route():
    if STATE["samples"] is None:
        return jsonify({"error": "尚未加载音频"}), 400
    body = request.get_json()
    stats = _render_audition(
        STATE["samples"], body["channels"], bool(body.get("protect"))
    )
    ts = int(time.time() * 1000)
    return jsonify(
        {
            "stats": stats,
            "audition": {
                "processed": f"/exports/_aud_processed.wav?t={ts}",
                "source": f"/exports/_aud_source.wav?t={ts}",
                "mono": f"/exports/_aud_mono.wav?t={ts}",
            },
        }
    )


@app.route("/api/export", methods=["POST"])
def export():
    if STATE["samples"] is None:
        return jsonify({"error": "尚未加载音频"}), 400
    body = request.get_json()
    channels = body["channels"]
    protect = bool(body.get("protect"))
    out, info = dsp.process(STATE["samples"], channels, protect)
    if info["clipping"] and not protect and not body.get("allowClip"):
        return (
            jsonify(
                {
                    "error": "输出峰值超出 16 位可表示范围且峰值保护已关闭,"
                    "已阻止导出以避免无提示的失真。"
                    "请开启峰值保护,或勾选“允许削波导出”后重试。",
                    "clipping": True,
                    "stats": info,
                }
            ),
            409,
        )
    name = time.strftime("export_%Y%m%d_%H%M%S.wav")
    path = os.path.join(EXPORT_DIR, name)
    seq = 1
    while os.path.exists(path):
        name = time.strftime("export_%Y%m%d_%H%M%S") + f"_{seq}.wav"
        path = os.path.join(EXPORT_DIR, name)
        seq += 1
    expected = dsp.write_wav(path, out)
    # 导出后重新读回,与预期量化结果比对(允许 1 个量化单位误差)
    back, _ = dsp.read_wav(path)
    back_q = dsp.quantize(back).astype(np.int32)
    diff = int(np.abs(back_q - expected.astype(np.int32)).max())
    return jsonify(
        {
            "file": f"/exports/{name}",
            "name": name,
            "stats": info,
            "samples": int(out.shape[0]),
            "readback": {"ok": diff <= 1, "maxDiffLsb": diff},
        }
    )


if __name__ == "__main__":
    print("打开 http://127.0.0.1:8048/")
    app.run(host="127.0.0.1", port=8048, debug=False)
