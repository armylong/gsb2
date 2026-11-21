# gsb2 — 二维攀爬试验场

TypeScript + Canvas 的 2D 攀爬试验场,用于核对「抓住平台边缘再翻上去」的完整过程:
可抓边缘、窄平台、顶部障碍、贴墙滑落、抓边、翻身(mantle)状态机。

## 本地启动

```bash
npm install
npm start          # 编译并起静态服务器, 打开 http://localhost:8080
```

操作:`←/→` 或 `A/D` 移动,`Space/W/↑` 跳(贴墙时为蹬墙跳),`S/↓` 抓住边缘时松手,`R` 复位,`1..5` 回放录入样例。

画面中会可视化:每个可抓顶角的绿色可抓范围圈、角色当前状态(颜色+左上角文字)、
抓住的具体边缘(黄色粗线段+平台 id/左右角标注)、低顶阻挡时的红色提示。

## 验证命令

```bash
npm run verify     # 编译并在 Node 中回放全部录入样例, 断言动作状态流转
```

样例在 `src/sim/samples.ts` 中程序内生成(出生点 + 逐帧输入 + 期望),覆盖:

| 样例 | 验证点 |
|---|---|
| `wall-slide` | 贴墙滑落,下落速度被钳制在 130 px/s |
| `failed-grab` | 起跳高度不足,手未进入可抓范围,不会进入 ledge |
| `low-ceiling` | 低顶阻挡翻身:不进入碰撞体,回到悬挂(可控),再按键取消松手 |
| `mantle-success` | 贴墙滑下抓住边缘,翻上平台站定 |
| `walk-off` | 走出平台边缘,支撑解除进入下落 |

所有样例还断言全局不变量:任意时刻角色不与碰撞体重叠(翻身不穿模)。

## 结构

- `src/sim/` — 纯逻辑仿真(类型 / 关卡 / 物理状态机 / 样例),不依赖 DOM
- `src/render.ts` `src/input.ts` `src/main.ts` — Canvas 渲染与浏览器主循环
- `test/verify.ts` — 样例回放断言器(`npm run verify`)
- `tools/serve.mjs` — 极简静态服务器
