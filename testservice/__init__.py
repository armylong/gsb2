"""只在本机运行的测试服务（含刻意植入的校验缺陷，供模糊测试验证）。

刻意植入的样例缺陷：

1. ``POST /api/users``       嵌套字段 ``profile.geo`` 收到 list/dict 时
                             触发 500（正常错误输入应返回 400）。
2. ``PUT /api/users/{id}``   未声明字段 ``is_admin`` 被静默写入并持久化
                             （响应 200，但数据被意外修改 -> 状态违反）。
3. ``POST /api/accounts/{id}/transactions`` 状态依赖缺陷：账户已关闭时，
                             非字符串 ``memo`` 触发 500；账户活跃时同样输入
                             只得到 400。
4. ``GET /api/redirect``     302 跳转到范围外地址，用于验证跳转拦截。

服务仅监听 127.0.0.1，数据保存在内存中，进程退出即清空。
"""
from .server import create_server, serve, reset_store, DEFAULT_PORT

__all__ = ["create_server", "serve", "reset_store", "DEFAULT_PORT"]
