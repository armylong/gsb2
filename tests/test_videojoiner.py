"""端到端自动化测试（标准库 unittest + 本机 ffmpeg）。

覆盖：
- 元数据探测（尺寸/帧率/声音/时长）
- 不同尺寸、不同帧率、无声音片段的统一规格化与拼接
- contain / cover 两种适配（黑边填充、居中裁切、绝不拉伸）
- 导出成品回读：时长、尺寸、帧率、片段顺序、交界黑帧/重复帧、分段音频
- 片段顺序调整、上限 6 段、出错片段单独替换后重新导出
- HTTP 服务的上传/移动/设置/状态接口与 multipart 解析
"""
from __future__ import annotations

import http.client
import json
import os
import shutil
import tempfile
import time
import unittest
import uuid

from videojoiner import MAX_CLIPS
from videojoiner.concat import write_concat_list
from videojoiner.normalize import build_video_filter
from videojoiner.project import ExportSettings, Project, ProjectError
from videojoiner.probe import ProbeError, probe_media
from videojoiner.samples import SAMPLE_SPECS, generate_samples
from videojoiner.server import parse_multipart, serve
from videojoiner.verify import verify_export


class VideoJoinerTestBase(unittest.TestCase):
    sample_paths: list[str] = []
    sample_root = ""

    @classmethod
    def setUpClass(cls):
        cls.sample_root = tempfile.mkdtemp(prefix="vj_samples_")
        cls.sample_paths = generate_samples(cls.sample_root)
        cls.sample_infos = [probe_media(p) for p in cls.sample_paths]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.sample_root, ignore_errors=True)

    def setUp(self):
        self.work = tempfile.mkdtemp(prefix="vj_test_")
        self.output = os.path.join(self.work, "out.mp4")

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def make_project(self, paths, **settings) -> Project:
        project = Project(os.path.join(self.work, "proj_" + uuid.uuid4().hex[:6]))
        for path in paths:
            project.add_clip(path)
        project.settings = ExportSettings(**settings)
        return project

    def export_and_verify(self, project, expect_pass: bool = True):
        result = project.export(self.output)
        self.assertTrue(result.ok, msg=f"导出失败：{result.error}")
        self.assertTrue(os.path.isfile(result.output_path))
        report = verify_export(result.output_path, project)
        if expect_pass:
            failed = [f"{c.name}: {c.detail}" for c in report.checks if not c.passed]
            self.assertTrue(report.passed, msg="；".join(failed))
        return result, report


class TestProbe(VideoJoinerTestBase):
    def test_sample_metadata_matches_specs(self):
        self.assertEqual(len(self.sample_paths), 6)
        for path, spec, info in zip(self.sample_paths, SAMPLE_SPECS, self.sample_infos):
            with self.subTest(name=spec[0]):
                self.assertEqual((info.width, info.height), (spec[1], spec[2]))
                self.assertAlmostEqual(info.fps,
                                       30000 / 1001 if spec[3] == "30000/1001"
                                       else float(spec[3]), delta=0.05)
                self.assertEqual(info.has_audio, spec[7])
                self.assertAlmostEqual(info.duration, spec[4], delta=0.12)

    def test_probe_invalid_file(self):
        bogus = os.path.join(self.work, "broken.mp4")
        with open(bogus, "wb") as fh:
            fh.write(b"this is not a video")
        with self.assertRaises(ProbeError):
            probe_media(bogus)

    def test_probe_missing_file(self):
        with self.assertRaises(ProbeError):
            probe_media(os.path.join(self.work, "nope.mp4"))


class TestNormalizeFilters(unittest.TestCase):
    def test_contain_uses_pad_never_stretch(self):
        vf = build_video_filter(1280, 720, 30, "contain")
        self.assertIn("force_original_aspect_ratio=decrease", vf)
        self.assertIn("pad=1280:720", vf)
        self.assertIn("setsar=1", vf)
        # 不能出现裸 scale=W:H（那才会拉伸）
        self.assertNotIn(f"scale=1280:720,", vf.replace("force_original_aspect_ratio", "X"))

    def test_cover_uses_crop(self):
        vf = build_video_filter(1920, 1080, 25, "cover")
        self.assertIn("force_original_aspect_ratio=increase", vf)
        self.assertIn("crop=1920:1080", vf)

    def test_unknown_fit_rejected(self):
        with self.assertRaises(ValueError):
            build_video_filter(640, 360, 30, "stretch")


class TestExportMixedClips(VideoJoinerTestBase):
    def test_mixed_sizes_fps_and_silent_clip_contain(self):
        # 前 5 段有声、尺寸帧率各异；第 6 段无声
        project = self.make_project(self.sample_paths, fit="contain",
                                    width=1280, height=720, fps=30)
        result, report = self.export_and_verify(project)

        actual = report.actual
        self.assertEqual((actual.width, actual.height), (1280, 720))
        self.assertAlmostEqual(actual.fps, 30, delta=0.1)
        self.assertTrue(actual.has_audio)
        self.assertEqual(len(report.order_samples), 6)
        # 顺序核对：每段时间窗中心颜色与样例预期一致
        self.assertTrue(all(s.get("matched") for s in report.order_samples))
        # 5 个交界都不能有黑帧/重复帧
        self.assertEqual(len(report.junction_frames), 5)
        self.assertFalse(any(j["black_frame"] or j["duplicate_frame"]
                             for j in report.junction_frames))
        # 音频分段：前 5 段有能量，第 6 段为静音
        rms = report.audio_segments
        self.assertEqual(len(rms), 6)
        self.assertTrue(all(r["rms_db"] > -60 for r in rms[:5]))
        self.assertLessEqual(rms[5]["rms_db"], -60)
        # 总时长 = 6 * 2s（允许编码余量）
        self.assertAlmostEqual(actual.duration, result.expected_duration, delta=0.4)

    def test_cover_mode_fills_frame_without_letterbox(self):
        # 竖屏片段在 cover 下应被裁满横屏画框：交界附近整帧不应出现黑边低亮度
        project = self.make_project(
            [self.sample_paths[2], self.sample_paths[0]],  # 竖屏 720x1280 + 横屏
            fit="cover", width=1280, height=720, fps=30)
        result, report = self.export_and_verify(project)
        junction = report.junction_frames[0]
        self.assertFalse(junction["black_frame"])
        self.assertGreater(junction["luma_before"], 20)
        self.assertGreater(junction["luma_after"], 20)

    def test_default_settings_follow_first_clip(self):
        project = self.make_project(
            [self.sample_paths[1]],  # 854x480 @24
            fit="contain")
        result, report = self.export_and_verify(project)
        self.assertEqual((report.actual.width, report.actual.height), (854, 480))
        self.assertAlmostEqual(report.actual.fps, 24, delta=0.1)

    def test_fractional_fps_output(self):
        project = self.make_project(
            [self.sample_paths[0], self.sample_paths[3]],  # 30fps + 29.97fps
            fit="contain", width=640, height=360, fps=29.97)
        result, report = self.export_and_verify(project)
        self.assertAlmostEqual(report.actual.fps, 29.97, delta=0.15)

    def test_concat_list_escapes_quotes(self):
        list_path = os.path.join(self.work, "list.txt")
        weird = os.path.join(self.work, "a b'c.mp4")
        write_concat_list([weird], list_path)
        with open(list_path, encoding="utf-8") as fh:
            content = fh.read()
        self.assertIn("'\\''", content)


class TestTimelineRules(VideoJoinerTestBase):
    def test_max_six_clips_enforced(self):
        project = Project(os.path.join(self.work, "p"))
        for path in self.sample_paths:
            project.add_clip(path)
        self.assertEqual(len(project.clips), MAX_CLIPS)
        with self.assertRaises(ProjectError):
            project.add_clip(self.sample_paths[0])

    def test_move_and_reorder_changes_output_order(self):
        project = self.make_project(
            [self.sample_paths[0], self.sample_paths[1], self.sample_paths[2]],
            fit="contain", width=640, height=360, fps=24)
        project.move_clip(project.clips[0].clip_id, 1)
        self.assertEqual(
            [c.path for c in project.clips],
            [self.sample_paths[1], self.sample_paths[0], self.sample_paths[2]])
        result, report = self.export_and_verify(project)
        names = [os.path.basename(c.path) for c in project.clips]
        from videojoiner.verify import EXPECTED_SAMPLE_SIGNATURE
        for sample, name in zip(report.order_samples, names):
            self.assertTrue(sample["matched"])
            self.assertEqual(sample["expected_signature"],
                             list(EXPECTED_SAMPLE_SIGNATURE[name]))

    def test_remove_and_estimated_duration(self):
        project = self.make_project(self.sample_paths[:3])
        self.assertAlmostEqual(project.estimated_duration(), 6.0, delta=0.05)
        project.remove_clip(project.clips[1].clip_id)
        self.assertEqual(len(project.clips), 2)
        self.assertAlmostEqual(project.estimated_duration(), 4.0, delta=0.05)

    def test_invalid_settings_rejected(self):
        project = self.make_project(self.sample_paths[:1])
        project.settings = ExportSettings(width=1281, height=720)  # 奇数宽
        with self.assertRaises(ProjectError):
            project.settings.validate()
        project.settings = ExportSettings(fit="stretch")
        with self.assertRaises(ProjectError):
            project.settings.validate()


class TestFailureAndReplace(VideoJoinerTestBase):
    def test_failed_clip_reported_then_replace_and_reexport(self):
        project = Project(os.path.join(self.work, "p"))
        good = project.add_clip(self.sample_paths[0])
        bogus_path = os.path.join(self.work, "broken.mp4")
        with open(bogus_path, "wb") as fh:
            fh.write(b"not a video")
        bad = project.add_clip(bogus_path)
        self.assertFalse(bad.ok)
        self.assertIn("ffprobe", bad.error)

        # 直接导出应被拒绝并指明片段
        with self.assertRaises(ProjectError) as ctx:
            project.export(self.output)
        self.assertIn("broken.mp4", str(ctx.exception))

        # 只替换出错片段，时间线位置不变，随后导出成功
        replaced = project.replace_clip(bad.clip_id, self.sample_paths[1])
        self.assertTrue(replaced.ok)
        self.assertEqual([c.clip_id for c in project.clips][0], good.clip_id)
        project.settings = ExportSettings(width=640, height=360, fps=24, fit="contain")
        result, report = self.export_and_verify(project)
        self.assertEqual(len(report.order_samples), 2)
        self.assertTrue(all(s["matched"] for s in report.order_samples))

    def test_normalize_failure_isolated_per_clip(self):
        project = self.make_project(self.sample_paths[:2],
                                    width=640, height=360, fps=24)
        # 模拟转码中途源文件被删：替换成不存在的路径并强制重新探测为失败状态
        clip = project.clips[1]
        gone = os.path.join(self.work, "gone.mp4")
        shutil.copy(self.sample_paths[1], gone)
        project.replace_clip(clip.clip_id, gone)
        os.remove(gone)
        project.re_probe()
        self.assertFalse(project.clips[1].ok)
        with self.assertRaises(ProjectError):
            project.export(self.output)


class TestProjectPersistence(VideoJoinerTestBase):
    def test_save_load_roundtrip(self):
        project = self.make_project(self.sample_paths[:3],
                                    width=640, height=360, fps=24)
        path = project.save()
        loaded = Project.load(path)
        self.assertEqual([c.path for c in loaded.clips],
                         [c.path for c in project.clips])
        self.assertEqual(loaded.settings.width, 640)
        self.assertEqual(loaded.estimated_duration(), project.estimated_duration())


class TestMultipartParsing(unittest.TestCase):
    def test_parse_files_and_text_fields(self):
        boundary = "----vjtestboundary"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="path"\r\n\r\n'
            "/tmp/a.mp4\r\n"
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="files"; filename="x y.mp4"\r\n'
            "Content-Type: video/mp4\r\n\r\n"
            "BINARYDATA"
            f"\r\n--{boundary}--\r\n"
        ).encode()
        parsed = parse_multipart(body, f"multipart/form-data; boundary={boundary}")
        self.assertEqual(parsed["path"][0]["content"], b"/tmp/a.mp4")
        self.assertEqual(parsed["files"][0]["filename"], "x y.mp4")
        self.assertEqual(parsed["files"][0]["content"], b"BINARYDATA")


class TestHTTPServer(VideoJoinerTestBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

    def setUp(self):
        super().setUp()
        self.httpd, self.url = serve(
            "127.0.0.1", 0, work_dir=os.path.join(self.work, "server"))
        self.port = self.httpd.server_address[1]
        import threading
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def _request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request(method, path, body=body or None, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def _json(self, method, path, payload=None):
        body = json.dumps(payload or {}).encode()
        status, data = self._request(
            method, path, body, {"Content-Type": "application/json"})
        return status, json.loads(data)

    def _multipart(self, method, path, fields: dict[str, str],
                   files: dict[str, tuple[str, bytes]]):
        boundary = "----vjhttp" + uuid.uuid4().hex
        chunks = []
        for name, value in fields.items():
            chunks.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n"
                .encode() + value.encode() + b"\r\n")
        for name, (filename, content) in files.items():
            chunks.append(
                f"--{boundary}\r\nContent-Disposition: form-data; "
                f"name=\"{name}\"; filename=\"{filename}\"\r\n"
                f"Content-Type: video/mp4\r\n\r\n".encode()
                + content + b"\r\n")
        chunks.append(f"--{boundary}--\r\n".encode())
        return self._request(method, path, b"".join(chunks),
                             {"Content-Type": f"multipart/form-data; boundary={boundary}"})

    def test_index_and_state(self):
        status, data = self._request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("本地视频拼接工具".encode(), data)
        status, data = self._json("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(data["max_clips"], MAX_CLIPS)

    def test_upload_move_settings_and_bad_file(self):
        with open(self.sample_paths[0], "rb") as fh:
            content = fh.read()
        status, data = self._multipart(
            "POST", "/api/clips", {}, {"files": ("a.mp4", content)})
        self.assertEqual(status, 200)
        snap = json.loads(data)["state"]
        self.assertEqual(len(snap["clips"]), 1)
        self.assertTrue(snap["clips"][0]["has_audio"])
        clip_id = snap["clips"][0]["clip_id"]

        # 再传一个坏文件：应返回 400 且错误信息明确
        status, data = self._multipart(
            "POST", "/api/clips", {}, {"files": ("broken.mp4", b"garbage")})
        self.assertEqual(status, 400)
        self.assertIn("ffprobe", json.loads(data)["error"])

        # 追加第二个有效片段并上移
        with open(self.sample_paths[1], "rb") as fh:
            content2 = fh.read()
        status, data = self._multipart(
            "POST", "/api/clips", {}, {"files": ("b.mp4", content2)})
        second_id = json.loads(data)["state"]["clips"][1]["clip_id"]
        status, snap = self._json(
            "PUT", f"/api/clips/{second_id}/move", {"direction": -1})
        self.assertEqual(status, 200)
        self.assertEqual(snap["clips"][0]["clip_id"], second_id)

        # 设置输出参数
        status, snap = self._json("PUT", "/api/settings",
                                  {"width": 640, "height": 360, "fps": 24,
                                   "fit": "cover"})
        self.assertEqual(status, 200)
        self.assertEqual(snap["effective_settings"]["width"], 640)

        # 非法设置被拒
        status, data = self._json("PUT", "/api/settings",
                                  {"width": 641, "height": 360, "fit": "cover"})
        self.assertEqual(status, 400)

        # 删除
        status, data = self._request("DELETE", f"/api/clips/{clip_id}")
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(data)["clips"]), 1)

    def test_path_traversal_static_blocked(self):
        status, _ = self._request("GET", "/static/../server.py")
        # 路径规范化后不应落到 web 目录之外
        self.assertIn(status, (403, 404))

    def test_full_export_and_verify_over_http(self):
        for path in self.sample_paths[:3]:
            with open(path, "rb") as fh:
                status, data = self._multipart(
                    "POST", "/api/clips", {},
                    {"files": (os.path.basename(path), fh.read())})
                self.assertEqual(status, 200)
        output = os.path.join(self.work, "http_out.mp4")
        status, data = self._json("POST", "/api/export", {"output": output})
        self.assertEqual(status, 200)

        deadline = time.time() + 90
        while time.time() < deadline:
            _, snap = self._json("GET", "/api/state")
            if not snap["export_running"]:
                break
            time.sleep(0.5)
        _, snap = self._json("GET", "/api/state")
        self.assertFalse(snap["export_running"])
        self.assertTrue(snap["last_result"]["ok"], msg=snap["last_result"])
        self.assertTrue(os.path.isfile(output))

        status, report = self._json("POST", "/api/verify")
        self.assertEqual(status, 200)
        self.assertTrue(report["passed"],
                        msg=json.dumps(report["checks"], ensure_ascii=False))
        self.assertEqual(len(report["order_samples"]), 3)
        self.assertEqual(len(report["junction_frames"]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
