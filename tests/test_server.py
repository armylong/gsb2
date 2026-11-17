"""HTTP 服务测试：分析接口（含 multipart）、静态资源、路径穿越防护。"""

import json
import os
import sys
import threading
import unittest
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from uvcheck.server import create_server, SAMPLES_DIR  # noqa: E402
from uvcheck.samples import generate_samples  # noqa: E402


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        generate_samples(SAMPLES_DIR)
        cls.httpd = create_server("127.0.0.1", 0)  # 端口 0 -> 系统分配
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)

    def _get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=10) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()

    def test_index_page(self):
        status, ctype, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn("UV".encode(), body)

    def test_static_js_and_css(self):
        for path in ("/app.js", "/styles.css"):
            status, _, body = self._get(path)
            self.assertEqual(status, 200)
            self.assertGreater(len(body), 100)

    def test_samples_listing_and_download(self):
        status, _, body = self._get("/api/samples")
        self.assertEqual(status, 200)
        files = json.loads(body)["files"]
        self.assertIn("sample_box.obj", files)
        status2, ctype, obj = self._get("/samples/sample_box.obj")
        self.assertEqual(status2, 200)
        self.assertIn(b"v ", obj)
        self.assertIn("text/", ctype)

    def test_analyze_text_plain(self):
        obj = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\n"
            "vt 1.5 0\nvt 2 0\nvt 2 1\n"
            "f 1/1 2/2 3/3\n"
        )
        req = urllib.request.Request(
            self.base + "/api/analyze?threshold=2.5",
            data=obj.encode("utf-8"),
            headers={"Content-Type": "text/plain", "X-Obj-Filename": "custom.obj"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
        self.assertEqual(payload["parse"]["source"], "custom.obj")
        self.assertEqual(payload["parse"]["stats"]["triangle_count"], 1)
        kinds = [i["type"] for i in payload["analysis"]["issues"]]
        self.assertIn("out_of_range", kinds)
        self.assertEqual(payload["analysis"]["thresholds"]["stretch_anisotropy"], 2.5)

    def test_analyze_multipart(self):
        boundary = "----uvchecktestboundary"
        obj = "v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="multi.obj"\r\n'
            "Content-Type: text/plain\r\n\r\n"
            f"{obj}\r\n--{boundary}--\r\n"
        ).encode("utf-8")
        req = urllib.request.Request(
            self.base + "/api/analyze",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read())
        self.assertEqual(payload["parse"]["source"], "multi.obj")
        kinds = [i["type"] for i in payload["analysis"]["issues"]]
        self.assertIn("missing_uv", kinds)

    def test_empty_post_rejected(self):
        req = urllib.request.Request(
            self.base + "/api/analyze", data=b"",
            headers={"Content-Type": "text/plain"}, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 400)

    def test_path_traversal_blocked(self):
        for evil in ("/samples/..%2f..%2fetc%2fpasswd", "/samples/../server.py"):
            try:
                status, _, _ = self._get(evil)
            except urllib.error.HTTPError as exc:
                self.assertIn(exc.code, (403, 404))
            else:
                self.assertNotEqual(status, 200)

    def test_unknown_route_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._get("/no/such/route")
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
