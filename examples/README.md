# 内置示例 (由 pause_editor.examples 重新生成, 种子固定)

采样率统一 16000 Hz, 16-bit PCM。

| 目录项 | 场景 |
|---|---|
| short_gap | 短间隔: 正常缩短 / 不足保留长度原样放过 / 硬切, M2 落在被删段 |
| adjacent | 修改区重叠与首尾挨住, 全部冲突不动, 成品长度==原声 |
| stereo_onsets | 左右声道响点错开, 只删双声道静音段 |

核对方式: `.venv/bin/python -m pause_editor.verify`
