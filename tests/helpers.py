"""测试基类与工具。"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dqtool.db import connect  # noqa: E402
from dqtool.rules import import_rules  # noqa: E402


class DqTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = os.path.join(self.tmp.name, "dq.db")
        self.conn = connect(self.db_path)
        self.addCleanup(self.conn.close)

    def write_file(self, name, content):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def write_json_file(self, name, obj):
        return self.write_file(name, json.dumps(obj, ensure_ascii=False))

    def import_rules(self, specs, note=""):
        return import_rules(self.conn, specs, note=note)


BASE_RULES = [
    {"id": "id_required", "type": "required", "field": "id"},
    {"id": "id_unique", "type": "unique", "field": "id"},
    {"id": "amount_type", "type": "type", "field": "amount", "params": {"dtype": "float"}},
    {"id": "amount_range", "type": "range", "field": "amount",
     "params": {"min": 0, "max": 100}},
    {"id": "date_order", "type": "relation",
     "params": {"left": "start", "op": "<=", "right": "end"}},
]
