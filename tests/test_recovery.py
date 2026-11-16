"""强制退出/中断后的恢复: 进程内钩子 + 子进程 os._exit 两种方式。"""

import json
import os
import subprocess
import sys
import unittest

from sync_tool import storage
from sync_tool.engine import SyncEngine
from sync_tool.verify import verify as run_verify

from tests.helpers import SyncTestCase


class _InProcessCrash(Exception):
    """模拟进程在 SQLite 事务提交前被杀掉(连接随之丢弃)。"""


class RecoveryTests(SyncTestCase):
    def test_crash_before_commit_in_process_resumes(self):
        engine, conn = self.bootstrap("clean")
        files = sorted(os.listdir(os.path.join(self.root, "changes")))
        # 只放到跨文件事务 T008 的提交标记所在文件
        self.move_change_files(files[3:], "held")

        calls = {"n": 0}

        def hook(point):
            # T008 第一次提交时崩, 之后放行
            if point == "before_commit:T008":
                calls["n"] += 1
                if calls["n"] == 1:
                    raise _InProcessCrash()

        engine.crash_hook = hook
        with self.assertRaises(_InProcessCrash):
            engine.sync_once()
        conn.close()  # 模拟进程死亡: 丢弃连接, SQLite 自动回滚未提交事务

        # 重启: 崩溃文件未登记, 整个文件重新接收
        engine2, conn2 = self.new_engine()
        summary = engine2.sync_once()
        self.assertIsNone(summary["blocked"], summary)
        # 暂存区无残留, 业务表里 T008 已整体生效
        self.assertEqual(engine2.status()["pending_txn"], [])
        customers = {r["id"]: r for r in self.target_rows("customer")}
        self.assertNotIn(3, customers)
        conn2.close()

    def test_sigkill_like_crash_in_subprocess(self):
        """用 SYNC_TOOL_CRASH 触发 os._exit, 等价于 kill -9 后重启。"""
        engine, conn = self.bootstrap("clean")
        conn.close()
        files = sorted(os.listdir(os.path.join(self.root, "changes")))
        self.move_change_files(files[3:], "held")
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        config = self.config_path

        # -I 隔离用户站点包与环境变量; PYTHONPATH 在 -I 下也会被忽略,
        # 因此用 sitecustomize 之外的稳妥方式: 显式 -m 配合 cwd=repo_root
        # 时 -I 仍不含 cwd, 这里改用 -I 之外再注入包目录到 sys.path 的驱动
        driver = (
            "import sys; sys.path.insert(0, %r); "
            "from sync_tool.cli import main; sys.exit(main())" % repo_root
        )
        env = dict(os.environ)
        env["SYNC_TOOL_CRASH"] = "before_commit:T008"
        proc = subprocess.run(
            [sys.executable, "-I", "-c", driver, "sync", "--config", config],
            cwd=repo_root, env=env, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 137, proc.stderr)

        # 强杀后状态: T008 没有半成品数据
        customers = {r["id"]: r for r in self.target_rows("customer")}
        self.assertIn(3, customers)
        engine2, conn2 = self.new_engine()
        status = engine2.status()
        # 已生效的只有 00001 里的 T007(到 seq 7); 00003 在 T008 提交前
        # 整体回滚, T008 的行事件暂存在 00002 里, 仍保留待续
        self.assertEqual(status["applied_seq"], 7)
        self.assertEqual(status["received_seq"], 9)
        self.assertEqual(
            [t["txn_id"] for t in status["pending_txn"]], ["T008"]
        )

        # 不带崩溃环境变量重启, 剩余文件送达后完整同步成功
        self.bring_back(files[3:], "held")
        proc2 = subprocess.run(
            [sys.executable, "-I", "-c", driver, "sync", "--config", config],
            cwd=repo_root, env=dict(os.environ), capture_output=True, text=True,
        )
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertTrue(result["ok"])
        conn2.close()

    def test_crash_between_files_keeps_file_atomicity(self):
        """在两个文件之间崩溃: 已提交文件的进度保留, 未处理文件重来。"""
        engine, conn = self.bootstrap("clean")
        files = sorted(os.listdir(os.path.join(self.root, "changes")))
        self.move_change_files(files[2:], "held")

        def hook(point):
            if point == "after_file:" + files[1]:
                raise _InProcessCrash()

        engine.crash_hook = hook
        with self.assertRaises(_InProcessCrash):
            engine.sync_once()
        applied = self.meta_value(storage.META_APPLIED_SEQ)
        conn.close()

        engine2, conn2 = self.new_engine()
        # 已登记文件重跑必须全部跳过, 不重复计数
        rerun = engine2.sync_once()
        self.assertEqual(rerun["files_processed"], 0)
        self.assertEqual(self.meta_value(storage.META_APPLIED_SEQ), applied)

        self.bring_back(files[2:], "held")
        summary = engine2.sync_once()
        self.assertIsNone(summary["blocked"])
        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertTrue(result["ok"])
        conn2.close()


if __name__ == "__main__":
    unittest.main()
