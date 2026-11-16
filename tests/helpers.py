"""测试公共辅助: 在临时目录生成数据并构造同步引擎。"""

import os
import shutil
import tempfile
import unittest

from sync_tool import datagen, storage
from sync_tool.config import Config
from sync_tool.engine import SyncEngine


class SyncTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="synctool_test_")
        self.config_path = os.path.join(self.root, "config.json")
        self.target_db = os.path.join(self.root, "target", "target.db")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def generate(self, mode="clean"):
        return datagen.generate(self.root, mode=mode)

    def load_config(self):
        return Config.load(self.config_path)

    def new_engine(self):
        config = self.load_config()
        conn = storage.connect(config.target_db)
        return SyncEngine(conn, config), conn

    def bootstrap(self, mode="clean"):
        """生成数据 + 装载快照, 返回 (engine, conn)。"""
        self.generate(mode)
        engine, conn = self.new_engine()
        engine.load_snapshot()
        return engine, conn

    def target_rows(self, table):
        """直接读取目标业务表的全部行(按主键排序), 用于断言。"""
        config = self.load_config()
        conn = storage.connect_readonly(config.target_db)
        try:
            rows = [dict(r) for r in conn.execute(f'SELECT * FROM "{table}"')]
        finally:
            conn.close()
        rows.sort(key=lambda r: tuple(str(v) for v in r.values()))
        return rows

    def meta_value(self, key):
        config = self.load_config()
        conn = storage.connect_readonly(config.target_db)
        try:
            return storage.meta_get(conn, key)
        finally:
            conn.close()

    def move_change_files(self, file_names, dest_name):
        """把 changes 目录里的文件搬到一个隔离目录, 模拟文件尚未送达。"""
        dest = os.path.join(self.root, dest_name)
        os.makedirs(dest, exist_ok=True)
        src_dir = os.path.join(self.root, "changes")
        for name in file_names:
            shutil.move(os.path.join(src_dir, name), os.path.join(dest, name))

    def bring_back(self, file_names, from_name):
        src_dir = os.path.join(self.root, from_name)
        dest_dir = os.path.join(self.root, "changes")
        for name in file_names:
            shutil.move(os.path.join(src_dir, name), os.path.join(dest_dir, name))
