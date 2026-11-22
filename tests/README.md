# 验收脚本

两个脚本都需要本机有 Playwright 的 Chromium：

- 默认读取 `~/Library/Caches/ms-playwright/chromium-1255/...`；
- 可用 `CHROME_PATH=/path/to/chrome` 指定，或用 `URL=` 指定服务地址。

先启动服务：

```bash
npm run dev            # 默认 http://127.0.0.1:5173
```

## smoke.mjs —— 交互冒烟（硬性断言，失败退出码 1）

```bash
URL=http://127.0.0.1:5173/ node tests/smoke.mjs
```

覆盖：

| 需求 | 检查 |
| --- | --- |
| 1 锚点跟随零件 | 每个锚点落在自己零件的世界包围盒内；摆臂转动后屏幕坐标跟随 |
| 2 拥挤避让 / 优先级 / 收起 | 任意视角下标签两两不重叠、不出界；锁定项被保留；锁定低优先级项后普通项让位；侧栏列出收起原因 |
| 3 遮挡 | 背面被挡数量显著多于正面；贴面锚点不误判；关闭「显示被挡」后不再放置被挡标签 |
| 4 稳定性 | 慢速拖拽确实转动了镜头；90 帧内 slot 不出现 A→B→A；切视角期间进入飞行态，结束后重新选位 |
| 5 点击与统一重排 | 点击标签选中零件并在侧栏高亮；隐藏零件后其锚点退出排布、其余仍不重叠；窄窗下收起数量增加 |

## browser-check.mjs —— 逐视角截图与统计

```bash
URL=http://127.0.0.1:5173/ node tests/browser-check.mjs
```

输出到 `/tmp/assembly-shots/`：各视角截图、`report.json`（每个锚点的
state / screen / rect / slot / placed / stowed，以及慢速旋转 90 帧的 slot 序列）。
