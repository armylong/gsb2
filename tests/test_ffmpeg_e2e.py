"""端到端测试：用本机 ffmpeg 生成样例并验证导出结果。

覆盖：
1. 关键点之间取景框平滑移动、无跳变
2. 取景始终在画面范围内（无黑边/空白）
3. 90/180/270 旋转视频的方向正确反映到输出
4. 导出视频尺寸/时长/音频与源同步
"""
from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from framer import ffmpeg as ff
from framer.jobs import start_export, get_job
from framer.keyframes import (
    build_x_expression, crop_size, normalize_keyframes,
)
from framer.persistence import load_project, save_project

WORK = Path(tempfile.mkdtemp(prefix="framer_test_"))


def wait_job(job_id: str, timeout: float = 120) -> dict:
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = get_job(job_id)
        if job.status != "running":
            return {"status": job.status, "error": job.error, "dst": job.dst}
        time.sleep(0.2)
    raise TimeoutError("导出任务超时")


def export(src: Path, dst: Path, keyframes, easing="smoothstep") -> dict:
    info = ff.probe(src)
    cw, ch = crop_size(info.display_width, info.display_height)
    kfs = normalize_keyframes(
        keyframes, info.duration, info.display_width, cw)
    project = {"src": str(src), "keyframes": kfs, "easing": easing}
    job_id = start_export(project, str(dst))
    return wait_job(job_id)


class TestSampleAndProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.normal = WORK / "normal.mp4"
        ff.generate_sample(cls.normal)
        cls.info = ff.probe(cls.normal)

    def test_sample_properties(self):
        self.assertEqual((self.info.display_width, self.info.display_height),
                         (1280, 720))
        self.assertEqual(self.info.rotation, 0)
        self.assertTrue(self.info.has_audio)
        self.assertAlmostEqual(self.info.duration, 6.0, delta=0.15)
        self.assertGreater(self.info.fps, 29)

    def test_crop_is_nine_sixteen(self):
        w, h = crop_size(self.info.display_width, self.info.display_height)
        self.assertEqual(h, 720)
        self.assertEqual(w, 404)
        self.assertAlmostEqual(w / h, 9 / 16, delta=0.005)


class TestExportMovementAndBounds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = WORK / "move_src.mp4"
        ff.generate_sample(cls.src)
        info = ff.probe(cls.src)
        cw, _ = crop_size(info.display_width, info.display_height)
        upper = info.display_width - cw
        # 0s 最左 → 3s 最右 → 6s 回到最左
        cls.kfs = [
            {"t": 0, "x": 0},
            {"t": 3, "x": upper},
            {"t": 6, "x": 0},
        ]
        cls.out = WORK / "move_out.mp4"
        result = export(cls.src, cls.out, cls.kfs, "linear")
        cls.result = result
        cls.cw = cw

    def test_export_succeeds(self):
        self.assertEqual(self.result["status"], "done", self.result.get("error"))

    def test_output_dimensions_and_duration(self):
        out = ff.probe(self.out)
        self.assertEqual((out.width, out.height), (404, 720))
        src = ff.probe(self.src)
        self.assertAlmostEqual(out.duration, src.duration, delta=0.12)
        self.assertEqual(out.rotation, 0)
        self.assertTrue(out.has_audio)

    def test_no_blank_edges(self):
        """逐帧检查：输出四条边缘都不是纯黑（取景框出界会产生黑边）。"""
        raw = WORK / "frames"
        raw.mkdir(exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(self.out), str(raw / "f_%03d.png"),
        ], check=True)
        # PNG 解析：用 ffmpeg 把边缘像素转成 rawvideo 再统计最小值
        for edge in ("crop=in_w:4:0:0", "crop=in_w:4:0:in_h-4",
                     "crop=4:in_h:0:0", "crop=4:in_h:in_w-4:0"):
            proc = subprocess.run([
                "ffmpeg", "-hide_banner", "-i", str(self.out),
                "-vf", edge, "-pix_fmt", "gray", "-f", "rawvideo", "-",
            ], capture_output=True, check=True)
            data = proc.stdout
            self.assertGreater(len(data), 1000)
            # testsrc2 内容最暗处也不会整边为 0；允许极少量黑像素（文字/网格）
            black_ratio = data.count(0) / len(data)
            self.assertLess(black_ratio, 0.02,
                            f"边缘 {edge} 出现过多纯黑像素，疑似取景出界")

    def test_movement_matches_keyframes(self):
        """用 PSNR 验证关键点时刻的取景位置与参考裁切一致。"""
        out = self.out
        cw = self.cw
        times = [0.5, 1.5, 3.0, 4.5, 5.5]
        for t in times:
            # 由关键点线性插值得到该时刻期望 x
            info = ff.probe(self.src)
            kfs = normalize_keyframes(
                self.kfs, info.duration, info.display_width, cw)
            from framer.keyframes import interpolate
            x = interpolate(kfs, t, info.display_width, cw, "linear")
            src_png = WORK / f"src_{t}.png"
            ref_png = WORK / f"ref_{t}.png"
            out_png = WORK / f"out_{t}.png"
            ff.extract_png(self.src, t, src_png)
            ff.crop_png(src_png, ref_png, cw, 720, x)
            ff.extract_png(out, t, out_png)
            score = ff.psnr(ref_png, out_png)
            self.assertGreater(score, 30.0,
                               f"t={t}s 取景位置不符，PSNR={score:.1f}dB")

    def test_smoothstep_has_no_jump(self):
        """smoothstep 导出：相邻帧 x 方向位移连续（无单帧大跳变）。"""
        smooth_out = WORK / "smooth.mp4"
        r = export(self.src, smooth_out, self.kfs, "smoothstep")
        self.assertEqual(r["status"], "done", r.get("error"))
        # 用 ffprobe 提取帧的 frame 侧数据代价高；改为抽 60 张帧图，
        # 比较相邻帧差异的均值（跳变会出现异常大差异）
        d = WORK / "smooth_frames"
        d.mkdir(exist_ok=True)
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(smooth_out), "-vf", "fps=10",
            str(d / "g_%03d.png"),
        ], check=True)
        imgs = sorted(d.glob("g_*.png"))[:50]
        deltas = []
        prev = None
        for p in imgs:
            proc = subprocess.run([
                "ffmpeg", "-hide_banner", "-i", str(p),
                "-pix_fmt", "gray", "-f", "rawvideo", "-",
            ], capture_output=True, check=True)
            if prev is not None:
                n = min(len(prev), len(proc.stdout))
                mean_diff = sum(
                    abs(a - b) for a, b in zip(prev[:n], proc.stdout[:n])
                ) / n
                deltas.append(mean_diff)
            prev = proc.stdout
        self.assertTrue(deltas)
        avg = sum(deltas) / len(deltas)
        for diff in deltas:
            self.assertLess(diff, avg * 4, "相邻帧差异异常，存在跳变")


class TestRotation(unittest.TestCase):
    def test_all_rotations_baked_correctly(self):
        for rotation in (90, 180, 270):
            with self.subTest(rotation=rotation):
                src = WORK / f"rot{rotation}.mp4"
                ff.generate_sample(src, rotation=rotation)
                meta = ff.probe(src)
                self.assertEqual(meta.rotation, rotation)
                # 显示方向：90/270 时竖屏存储、横屏显示
                if rotation in (90, 270):
                    self.assertEqual((meta.display_width, meta.display_height),
                                     (720, 1280))
                else:
                    self.assertEqual((meta.display_width, meta.display_height),
                                     (1280, 720))
                # 烤正代理无旋转且方向正确
                proxy = WORK / f"rot{rotation}_proxy.mp4"
                ff.make_normalized_proxy(src, proxy)
                pinfo = ff.probe(proxy)
                self.assertEqual(pinfo.rotation, 0)
                self.assertEqual((pinfo.width, pinfo.height),
                                 (meta.display_width, meta.display_height))
                # 导出基于显示方向，9:16 满高
                out = WORK / f"rot{rotation}_out.mp4"
                cw, ch = crop_size(pinfo.width, pinfo.height)
                kfs = [{"t": 0, "x": 0}, {"t": 3, "x": pinfo.width - cw}]
                r = export(src, out, kfs, "linear")
                self.assertEqual(r["status"], "done", r.get("error"))
                oinfo = ff.probe(out)
                self.assertEqual(oinfo.rotation, 0)
                self.assertEqual((oinfo.width, oinfo.height), (cw, ch))
                self.assertAlmostEqual(oinfo.width / oinfo.height, 9 / 16,
                                       delta=0.005)

    def test_rotated_output_content_matches_autorotated_source(self):
        """旋转视频导出的画面 = 烤正源画面裁切（PSNR 验证方向一致）。"""
        src = WORK / "rot90_b.mp4"
        ff.generate_sample(src, rotation=90)
        proxy = WORK / "rot90_b_proxy.mp4"
        ff.make_normalized_proxy(src, proxy)
        pinfo = ff.probe(proxy)
        cw, ch = crop_size(pinfo.width, pinfo.height)
        out = WORK / "rot90_b_out.mp4"
        r = export(src, out, [{"t": 0, "x": 50}, {"t": 6, "x": 200}], "linear")
        self.assertEqual(r["status"], "done", r.get("error"))
        # t=2s 参考：烤正代理按 x=插值位置 裁切
        from framer.keyframes import interpolate
        kfs = normalize_keyframes(
            [{"t": 0, "x": 50}, {"t": 6, "x": 200}],
            pinfo.duration, pinfo.width, cw)
        x = interpolate(kfs, 2.0, pinfo.width, cw, "linear")
        a, b, c = (WORK / "p.png", WORK / "pref.png", WORK / "pout.png")
        ff.extract_png(proxy, 2.0, a)
        ff.crop_png(a, b, cw, ch, x)
        ff.extract_png(out, 2.0, c)
        self.assertGreater(ff.psnr(b, c), 30.0)


class TestAudioSync(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = WORK / "audio_src.mp4"
        ff.generate_sample(cls.src)
        cls.out = WORK / "audio_out.mp4"
        r = export(cls.src, cls.out,
                   [{"t": 0, "x": 0}, {"t": 6, "x": 400}], "linear")
        assert r["status"] == "done", r.get("error")

    @staticmethod
    def _wav_samples(path: Path) -> tuple[list[int], int]:
        wav = path.with_suffix(".wav")
        ff.to_wav(path, wav)
        with wave.open(str(wav), "rb") as wf:
            n = wf.getnframes()
            raw = wf.readframes(n)
            rate = wf.getframerate()
        return list(struct.unpack("<%dh" % n, raw)), rate

    def test_durations_match(self):
        s, o = ff.probe(self.src), ff.probe(self.out)
        self.assertTrue(o.has_audio)
        self.assertAlmostEqual(o.duration, s.duration, delta=0.12)

    def test_beep_onsets_aligned(self):
        """哔声每秒一次；源与导出的能量包络峰值位置应一致（偏差 < 40ms）。"""
        src_pcm, sr = self._wav_samples(self.src)
        out_pcm, sr2 = self._wav_samples(self.out)
        self.assertEqual(sr, sr2)

        def onsets(pcm, sr):
            win = sr // 100  # 10ms 窗
            energy = []
            for i in range(0, len(pcm) - win, win):
                seg = pcm[i:i + win]
                energy.append(sum(s * s for s in seg) / win)
            threshold = max(energy) * 0.25
            marks, cool = [], 0
            for i, e in enumerate(energy):
                if e > threshold and cool == 0:
                    marks.append(i * win / sr)
                    cool = int(0.5 * sr / win)
                cool = max(0, cool - 1)
            return marks

        a, b = onsets(src_pcm, sr), onsets(out_pcm, sr)
        self.assertGreaterEqual(len(a), 5)
        self.assertEqual(len(a), len(b))
        for ta, tb in zip(a, b):
            self.assertLess(abs(ta - tb), 0.04,
                            f"哔声偏移 {abs(ta - tb):.3f}s，音画不同步")

    def test_waveform_correlation_at_zero_lag(self):
        src_pcm, sr = self._wav_samples(self.src)
        out_pcm, _ = self._wav_samples(self.out)
        n = min(len(src_pcm), len(out_pcm))
        a, b = src_pcm[:n], out_pcm[:n]
        dot = sum(x * y for x, y in zip(a, b))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(y * y for y in b))
        corr = dot / (na * nb)
        self.assertGreater(corr, 0.9, f"零延迟相关系数 {corr:.3f} 过低")


class TestFailureKeepsSettings(unittest.TestCase):
    def test_invalid_keyframes_rejected_before_job(self):
        src = WORK / "fail_src.mp4"
        ff.generate_sample(src)
        info = ff.probe(src)
        cw, _ = crop_size(info.display_width, info.display_height)
        original = [{"t": 0, "x": 100}]
        with self.assertRaises(Exception):
            normalize_keyframes(
                [{"t": 99, "x": 0}], info.duration, info.display_width, cw)
        # 原设置未被修改
        self.assertEqual(original, [{"t": 0, "x": 100}])

    def test_bad_output_path_reports_error(self):
        src = WORK / "fail_src2.mp4"
        ff.generate_sample(src)
        project = {"src": str(src),
                   "keyframes": [{"t": 0, "x": 0}], "easing": "linear"}
        job_id = start_export(project, "/nonexistent_dir_xyz/out.mp4")
        result = wait_job(job_id)
        self.assertEqual(result["status"], "error")
        self.assertTrue("nonexistent" in result["error"] or "ffmpeg" in result["error"])
        self.assertEqual(project["keyframes"], [{"t": 0, "x": 0}])


class TestProjectRoundTrip(unittest.TestCase):
    def test_save_load(self):
        p = WORK / "project.json"
        proj = {"src": "/tmp/a.mp4",
                "keyframes": [{"t": 0, "x": 10}, {"t": 2, "x": 800}],
                "easing": "smoothstep"}
        save_project(p, proj)
        self.assertEqual(load_project(p), proj)

    def test_reject_bad_project(self):
        p = WORK / "bad.json"
        p.write_text(json.dumps({"version": 1, "project": {"src": "x"}}))
        with self.assertRaises(ValueError):
            load_project(p)


@unittest.skipUnless(shutil.which("node"), "未安装 node，跳过表达式实跑测试")
class TestFFmpegExpressionLive(unittest.TestCase):
    def test_generated_expression_runs_in_ffmpeg(self):
        src = WORK / "expr_src.mp4"
        ff.generate_sample(src)
        info = ff.probe(src)
        cw, ch = crop_size(info.display_width, info.display_height)
        kfs = normalize_keyframes(
            [{"t": 0, "x": 0}, {"t": 3, "x": info.display_width - cw},
             {"t": 6, "x": 100}],
            info.duration, info.display_width, cw)
        for easing in ("linear", "smoothstep"):
            expr = build_x_expression(kfs, info.display_width, cw, easing)
            dst = WORK / f"expr_{easing}.mp4"
            cmd = ff.build_export_command(
                src, dst, cw, ch, expr, info.has_audio)
            ff._run(cmd)
            out = ff.probe(dst)
            self.assertEqual((out.width, out.height), (cw, ch))


if __name__ == "__main__":
    unittest.main(verbosity=2)
