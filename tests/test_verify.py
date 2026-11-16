"""一致性校验与运行中校验的时间点安全性。"""

import os
import threading
import unittest

from sync_tool import storage
from sync_tool.engine import quote_ident
from sync_tool.verify import verify as run_verify

from tests.helpers import SyncTestCase


class VerifyTests(SyncTestCase):
    def test_verify_passes_at_committed_position(self):
        engine, conn = self.bootstrap("clean")
        engine.sync_once()
        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertTrue(result["ok"], result)
        for report in result["tables"].values():
            self.assertEqual(report["expected_count"], report["actual_count"])
        conn.close()

    def test_verify_detects_row_and_content_drift(self):
        engine, conn = self.bootstrap("clean")
        engine.sync_once()

        # 直接篡改目标库: 删一行 + 改一个字段, 校验必须全部抓出来
        conn.execute('DELETE FROM customer WHERE id = 2')
        conn.execute('UPDATE customer SET city = ? WHERE id = 1', ("火星",))
        conn.commit()

        result = run_verify(storage.connect_readonly(self.target_db),
                            self.load_config())
        self.assertFalse(result["ok"])
        cust = result["tables"]["customer"]
        self.assertEqual(cust["actual_count"], cust["expected_count"] - 1)
        self.assertEqual(cust["missing"][0]["key"], [2])
        self.assertEqual(cust["content_diff"][0]["key"], [1])
        self.assertEqual(
            cust["content_diff"][0]["columns"]["city"]["expected"], "深圳"
        )
        conn.close()

    def test_verify_while_uncommitted_txn_open_uses_single_snapshot(self):
        """同步停在跨文件事务中间时, verify 只能基于已提交位置给结论。"""
        engine, conn = self.bootstrap("clean")
        files = sorted(os.listdir(os.path.join(self.root, "changes")))
        self.move_change_files(files[2:], "held")
        engine.sync_once()
        # 此时 T008 在暂存区, applied_seq 落后于 received_seq
        self.assertGreater(
            engine.status()["received_seq"], engine.status()["applied_seq"]
        )

        # 用独立只读连接(模拟另一个进程)校验, 必须成功且通过:
        # 视图取自同一个只读事务, 不会混到不同时间点
        ro = storage.connect_readonly(self.target_db)
        result = run_verify(ro, self.load_config())
        ro.close()
        self.assertTrue(result["ok"], result)
        self.assertEqual(
            result["at_applied_seq"], engine.status()["applied_seq"]
        )
        conn.close()

    def test_verify_concurrent_with_writer_never_mixes_timepoints(self):
        """校验进行中, 另一个连接提交新事务: 校验视图保持旧快照一致。"""
        engine, conn = self.bootstrap("clean")
        engine.sync_once()
        config = self.load_config()
        ro = storage.connect_readonly(config.target_db)

        inside = threading.Event()
        release = threading.Event()

        def verify_worker():
            # 手动复刻 verify 的关键时序: 先开只读事务并读完一轮,
            # 期间让写连接提交, 再在同一事务里重读, 结果必须自洽
            ro.execute("BEGIN")
            try:
                seq_before = storage.meta_get(ro, storage.META_APPLIED_SEQ)
                count_before = ro.execute(
                    "SELECT COUNT(*) AS c FROM customer"
                ).fetchone()["c"]
                inside.set()
                release.wait(timeout=5)
                seq_after = storage.meta_get(ro, storage.META_APPLIED_SEQ)
                count_after = ro.execute(
                    "SELECT COUNT(*) AS c FROM customer"
                ).fetchone()["c"]
                self.assertEqual(seq_before, seq_after)
                self.assertEqual(count_before, count_after)
            finally:
                ro.rollback()

        t = threading.Thread(target=verify_worker)
        t.start()
        self.assertTrue(inside.wait(timeout=5))
        # 校验事务打开期间直接提交一笔写入
        conn.execute(
            'INSERT INTO customer(id, name, city, _last_txn_id, _last_seq, _last_op)'
            " VALUES (77, '并发写入', '测试', 'TCONC', 9999, 1)"
        )
        conn.commit()
        release.set()
        t.join(timeout=5)
        self.assertFalse(t.is_alive())

        # 新的一轮校验能看到新写入并通过重放发现归属差异(内容数仍由校验兜底)
        result = run_verify(storage.connect_readonly(self.target_db), config)
        # 直接插入的记录没有对应源事件 -> 校验判为 extra
        self.assertFalse(result["ok"])
        self.assertTrue(
            any(d["key"] == [77] for d in result["tables"]["customer"]["extra"])
        )
        conn.close()


if __name__ == "__main__":
    unittest.main()
