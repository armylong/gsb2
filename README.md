# 积木接力台 · TypeScript + Canvas 短关原型

一块桌游式积木接力台：在固定槽位上摆放细木片和宽木片并调整朝向，启动后按确定性的“拍”播放连锁倒下。需要让 A、B 两面终点旗按顺序和最小间隔落地，同时避开禁碰槽、挡柱和错误侧的单向片，并满足用片数量。

## 本地运行

```bash
npm install
npm start
# 打开 http://127.0.0.1:5173
```

`npm start` 会先执行 TypeScript 编译，再用 Python 静态服务器托管仓库根目录。也可以分两个终端：

```bash
npm run dev      # tsc --watch
npm run serve    # python3 -m http.server 5173
```

运行时没有第三方依赖；只有 TypeScript / Node 类型作为开发依赖。

## 验证

```bash
npm test
npm run verify
```

- `npm test`：编译并运行 Node 内置测试，覆盖通关摆法、提前倒旗陷阱、同拍合并、两路合槽、挡柱/单向片、禁碰槽、数量检查、逐拍快照和重复哈希。
- `npm run verify`：把 5 个本地样例各生成两次完整回看 JSON，比较规范化 JSON 和 SHA-256，并写出：
  - `artifacts/verification-report.json`：拍数、哈希、同拍组数量；
  - `artifacts/replay-records.json`：完整回看记录。

连续执行两次 `npm run verify`，同一代码下哈希应保持一致。

## 操作

- 选择“细木片 / 宽木片”后，点空槽摆放。
- 点已有木片选中；`R`、双击、右键或“转向”按钮顺时针转向。
- `Delete` / `Backspace` 拆除选中片，`Esc` 取消选中。
- `Space` 开始/暂停；`←` / `→` 退回或前进一拍。
- 播放时可拖动回看轴，也可点击右侧事件日志跳到对应拍。
- “返回原摆放修改”只退出回放视图，保留原始摆放；再次开始会重新模拟，不继承任何倒下状态。

## 规则和时间

模拟采用确定性整数拍，`1 拍 = 100ms`：

| 物件 | 碰到后产生下一次碰撞 | 从触碰到落地 |
| --- | ---: | ---: |
| 启动片 | 2 拍 | 5 拍 / 0.5s |
| 细木片 | 3 拍 | 6 拍 / 0.6s |
| 宽木片 | 4 拍 | 9 拍 / 0.9s |
| 单向片 | 3 拍 | 7 拍 / 0.7s |
| 终点旗 | — | 8 拍 / 0.8s |

宽木片只能放在蓝色“宽槽”，朝 `facing` 和顺时针侧向同时给出两条碰撞方向。

同一拍内进入同一槽的多路碰撞会先成组，再确定性地选择一路触发，其余记为 `merged-same-beat`。之后才到达的路线会看到 `already-falling` 或 `already-fallen`，不会增加接受碰撞次数。

## 内置内容

- **第 1 关 · 绕柱过街**：朝向、挡柱、单向片、禁碰槽和基础时差。
- **第 2 关 · 太早倒下的 B 旗**：东侧短路看起来接通，但 B 旗会比 A 旗更早落地；南侧长路才满足间隔。关卡面板可一键载入这个“会失败的短路陷阱”，但不会直接载入通关解。
- **样例 A · 同拍相撞**：两条等时路线在第 18 拍进入 `slot-4-2`，记录为 1 条 `triggered` + 1 条 `merged-same-beat`。
- **样例 B · 两路合进同槽**：短路第 12 拍触发 `slot-4-2`，该片第 18 拍落地；长路第 24 拍到达，记录为 `already-fallen`。

两个样例页签内都有“载入可重复样例摆法”。普通关卡只给方向性提示，不提供一键完整解；自动化测试使用的校验摆法保存在 `src/game/fixtures.ts`。

## 回看记录

每次开始都会生成 `ReplayRecord`：

- 最终摆放和编辑动作；
- 每拍碰撞、触发、落地快照；
- 同拍碰撞分组 `sameBeatCollisionGroups`；
- 通关检查结果和两面旗的触碰/落地拍；
- `winningActions` 截取最近一次清空或载入样例后的动作链。

通关记录会尝试保存到浏览器 `localStorage`，并可从右侧面板导出/复制 JSON 或下载最近一次通关记录。

## 代码地图

```text
src/game/types.ts       所有确定性状态、事件、检查和回看记录类型
src/game/geometry.ts    方向、坐标和宽片双出口
src/game/engine.ts      纯函数模拟、逐拍快照、通关检查、回看 JSON
src/game/levels.ts      ASCII 地图解析、两小关和两个可重复样例
src/game/fixtures.ts    测试/本地验证使用的已知摆法
src/ui/renderer.ts      Canvas 地图、倒下动画、阻挡原因和同拍标记
src/main.ts             DOM/Canvas 交互、播放循环、导入导出和本地存档
test/relay.test.ts      Node 确定性测试
scripts/verify-local.ts 重复计算和哈希校验
```
