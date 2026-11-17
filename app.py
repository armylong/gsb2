"""本地网页界面 + API。启动: python3 app.py [port]，浏览器打开 http://127.0.0.1:8765"""
import io
import os

import numpy as np
import soundfile as sf
from flask import Flask, jsonify, request, send_file, send_from_directory

import duckcore as dc

app = Flask(__name__, static_folder='static')

STATE = dict(
    narration=None, music=None, sr=None,
    segments=[], params=dict(dc.DEFAULTS),
    result=None, original=None,
    paths=dict(narration='', music=''),
)


def reprocess():
    if STATE['narration'] is None:
        return
    STATE['result'] = dc.process(STATE['music'], STATE['narration'],
                                 STATE['sr'], STATE['segments'],
                                 STATE['params'])
    n = len(STATE['narration'])
    music = dc.to_stereo(STATE['music'].astype(np.float64))[:n]
    if len(music) < n:
        music = np.vstack([music, np.zeros((n - len(music), 2))])
    STATE['original'] = (music + STATE['narration'][:, None]).astype(np.float32)


def public_state():
    r = STATE['result']
    return dict(
        loaded=STATE['narration'] is not None,
        paths=STATE['paths'],
        sr=STATE['sr'],
        duration=(len(STATE['narration']) / STATE['sr']
                  if STATE['narration'] is not None else 0),
        segments=STATE['segments'],
        merged=(r['merged'] if r else []),
        params=STATE['params'],
        peak=(r['peak'] if r else 0),
        protection_triggered=(r['protection_triggered'] if r else False),
        protection_gain_db=(r['protection_gain_db'] if r else 0),
        final_peak=(r['final_peak'] if r else 0),
        final_peak_db=(r['final_peak_db'] if r else -120),
        curve=(dc.downsample_curve(r['gain']) if r else []),
        curve_n=(len(r['gain']) if r else 0),
    )


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/api/samplepaths')
def api_samplepaths():
    root = os.path.abspath(os.path.dirname(__file__))
    return jsonify(dict(
        narration=os.path.join(root, 'samples', 'narration.wav'),
        music=os.path.join(root, 'samples', 'music.wav'),
        export=os.path.join(root, 'samples', 'export_mix.wav')))


@app.route('/api/load', methods=['POST'])
def api_load():
    b = request.get_json(force=True)
    npath, mpath = b['narration'], b['music']
    narration, sr_n = dc.load_wav(npath)
    music, sr_m = dc.load_wav(mpath)
    narration = dc.to_mono(narration)
    if len(narration) / sr_n > 30.0 + 1e-6:
        return jsonify(error='旁白超过 30 秒'), 400
    if sr_m != sr_n:
        music = dc.resample_linear(music, sr_m, sr_n)
    music = dc.to_stereo(music)
    if len(music) < len(narration):
        return jsonify(error='音乐短于旁白'), 400
    STATE.update(narration=narration.astype(np.float32),
                 music=music.astype(np.float32), sr=sr_n,
                 paths=dict(narration=os.path.abspath(npath),
                            music=os.path.abspath(mpath)))
    STATE['segments'] = dc.detect_speech(narration, sr_n)
    reprocess()
    return jsonify(public_state())


@app.route('/api/detect', methods=['POST'])
def api_detect():
    b = request.get_json(force=True) if request.data else {}
    off = float(b.get('thresh_offset_db', 12.0))
    STATE['segments'] = dc.detect_speech(STATE['narration'], STATE['sr'],
                                         thresh_offset_db=off)
    reprocess()
    return jsonify(public_state())


@app.route('/api/segments', methods=['POST'])
def api_segments():
    b = request.get_json(force=True)
    dur = len(STATE['narration']) / STATE['sr']
    segs = []
    for s, e in b['segments']:
        s, e = max(0.0, float(s)), min(dur, float(e))
        if e - s >= 0.02:
            segs.append((s, e))
    segs.sort()
    STATE['segments'] = segs
    reprocess()
    return jsonify(public_state())


@app.route('/api/params', methods=['POST'])
def api_params():
    b = request.get_json(force=True)
    p = STATE['params']
    for k in dc.DEFAULTS:
        if k in b:
            p[k] = float(b[k])
    reprocess()
    return jsonify(public_state())


@app.route('/api/waveform')
def api_waveform():
    which = request.args.get('track', 'narration')
    x = STATE.get(which)
    if x is None:
        return jsonify(peaks=[])
    return jsonify(peaks=dc.waveform_peaks(x), sr=STATE['sr'])


@app.route('/api/audio')
def api_audio():
    which = request.args.get('which', 'mix')
    if STATE['narration'] is None:
        return 'not loaded', 400
    if which == 'mix':
        data = STATE['result']['out']
    elif which == 'original':
        data = STATE['original']
    elif which == 'narration':
        data = STATE['narration']
    elif which == 'music':
        data = STATE['music'][:len(STATE['narration'])]
    else:
        return 'unknown', 400
    buf = io.BytesIO()
    sf.write(buf, np.asarray(data, dtype=np.float32), STATE['sr'],
             subtype='PCM_16', format='WAV')
    buf.seek(0)
    return send_file(buf, mimetype='audio/wav')


@app.route('/api/export', methods=['POST'])
def api_export():
    b = request.get_json(force=True) if request.data else {}
    path = b.get('path') or os.path.join(os.getcwd(), 'export_mix.wav')
    path = os.path.abspath(path)
    r = STATE['result']
    dc.write_wav(path, r['out'], STATE['sr'])

    # 重新载入核对：时长与采样数据必须与内存中的处理结果一致
    back, sr_back = dc.load_wav(path)
    back = dc.to_stereo(back)
    n_ok = abs(len(back) - r['n_samples'])
    ref_q = (np.clip(r['out'], -1, 1) * 32767).round().astype(np.int16)
    back_q = (np.clip(back[:r['n_samples']], -1, 1) * 32767).round().astype(np.int16)
    max_diff = int(np.max(np.abs(ref_q.astype(np.int32)
                                 - back_q.astype(np.int32)))) if len(back_q) else -1
    ok = bool(sr_back == STATE['sr'] and n_ok <= 1 and max_diff <= 1)
    return jsonify(dict(path=path, ok=ok, sr=sr_back,
                        n_samples=int(len(back)),
                        expected_samples=int(r['n_samples']),
                        sample_diff=n_ok, max_sample_err_lsb=max_diff,
                        final_peak=r['final_peak'],
                        final_peak_db=r['final_peak_db'],
                        protection_triggered=r['protection_triggered']))


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8765))
    print(f'打开 http://127.0.0.1:{port}')
    app.run(host='127.0.0.1', port=port, debug=False)
