"""HTTP API 冒烟测试：在随机端口启动服务，覆盖主要接口与 Range 请求。"""
import json
import tempfile
import threading
import sys
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from framer import ffmpeg as ff
from framer.server import serve

WORK = Path(tempfile.mkdtemp(prefix="framer_api_"))


def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.status, r.headers, r.read()


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class TestServerAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = serve(port=0)
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.src = WORK / "api_sample.mp4"
        ff.generate_sample(cls.src)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)

    def test_index(self):
        status, _, body = get(self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn("竖屏取景".encode(), body)

    def test_info_and_media_range(self):
        status, _, body = get(self.base + "/api/info?path=" + str(self.src))
        self.assertEqual(status, 200)
        info = json.loads(body)["info"]
        self.assertEqual((info["display_width"], info["display_height"]),
                         (1280, 720))
        # Range 请求
        req = urllib.request.Request(
            self.base + "/api/media?path=" + str(self.src),
            headers={"Range": "bytes=0-1023"})
        with urllib.request.urlopen(req, timeout=30) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(len(r.read()), 1024)

    def test_bad_path_rejected(self):
        import urllib.error
        with self.assertRaises(urllib.error.HTTPError):
            get(self.base + "/api/info?path=/no/such/file.mp4")

    def test_sample_endpoint(self):
        status, data = post(self.base + "/api/sample", {"kind": "rot90"})
        self.assertEqual(status, 200)
        self.assertEqual(data["info"]["rotation"], 90)

    def test_proxy_endpoint(self):
        status, data = post(self.base + "/api/proxy", {"path": str(self.src)})
        self.assertEqual(status, 200)
        self.assertTrue(Path(data["proxy"]).is_file())

    def test_export_flow_and_verify(self):
        out = str(WORK / "api_out.mp4")
        project = {
            "src": str(self.src),
            "keyframes": [{"t": 0, "x": 0}, {"t": 6, "x": 800}],
            "easing": "linear",
        }
        status, data = post(self.base + "/api/export",
                            {"project": project, "output": out})
        self.assertEqual(status, 200)
        job_id = data["jobId"]
        import time
        for _ in range(200):
            s, _, body = get(self.base + "/api/job?id=" + job_id)
            job = json.loads(body)
            if job["status"] != "running":
                break
            time.sleep(0.3)
        self.assertEqual(job["status"], "done", job.get("error"))
        s, _, body = get(self.base + "/api/verify?path=" + out)
        info = json.loads(body)["info"]
        self.assertEqual((info["width"], info["height"]), (404, 720))

    def test_export_rejects_invalid_keyframes(self):
        out = str(WORK / "should_not_exist.mp4")
        project = {"src": str(self.src),
                   "keyframes": [{"t": 99, "x": 0}], "easing": "linear"}
        status, data = post(self.base + "/api/export",
                            {"project": project, "output": out})
        self.assertEqual(status, 400)
        self.assertFalse(Path(out).exists())

    def test_project_save_load(self):
        p = str(WORK / "p.json")
        proj = {"src": str(self.src),
                "keyframes": [{"t": 0, "x": 50}], "easing": "linear"}
        status, _ = post(self.base + "/api/project/save",
                         {"path": p, "project": proj})
        self.assertEqual(status, 200)
        status, data = post(self.base + "/api/project/load", {"path": p})
        self.assertEqual(status, 200)
        self.assertEqual(data["project"], proj)


if __name__ == "__main__":
    unittest.main(verbosity=2)
