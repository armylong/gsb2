# 叠印 · 纸版印画

一个用 TypeScript + Canvas 写的纸版叠印解谜小游戏。纸板只有有限格，玩家挑选透明墨与带孔模板，转动、翻面、定位后盖下；每格的最终颜色只由这一格上叠过的墨层顺序决定。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # 类型检查 + 生产构建
npm test           # 规则与操作串单元测试
npm run verify     # 命令行验证 operations/*.ops.txt
npm run verify -- heart   # 只验证名字含 heart 的操作串
```

开发期的浏览器巡检用 Playwright（已列入 devDependencies，首次需 `npx playwright install chromium`），先启动 `npm run preview`，再在另一个终端：

```bash
npm run e2e        # 端到端：盖印、拒绝、撤回、挡墨、查看、演示
npm run e2e:keys   # 键盘快捷键与演示隔离
npm run shots      # 桌面 / 移动端截图到 tmp/shots
node scripts/responsive.mjs   # 多种宽度下检查无横向滚动
```

## 玩法

- **选墨**：点右侧墨色卡（或按 `1`、`2`）。墨量按“实际接触到的棋盘格数”结算；同一格反复盖也各计一次。
- **选模板**：点模板卡（或 `[` `]`）。`R` 顺时针转动 90°，`F` 翻面；方向键移动模板定位点，定位点画成小圆圈。
- **盖印**：鼠标悬停会预览本次孔位，点击纸面即盖印；按 `↵` 也可以。触屏上先轻点定位，再按「盖印」。
- **挡墨纸**：切到「挡墨纸」模式（`M`）点击格子，贴上或收回。被挡住的格完全不沾墨，拿掉后原色仍在；挡墨不耗墨。
- **保留格**：样图里带斜线的格必须干净。一旦沾墨，整次印画判失败；「撤回」会返还这一印的用量。
- **查看**：切到「查看」模式（`I`）点格子，右侧按“新 → 旧”列出每一层墨来自第几印、哪片模板与朝向；失败时还会指出本次新弄脏了哪些格。
- **预演**：「定格预演」（`P`）冻结当前盖印效果，不耗墨、不计记录，方便对照。
- **撤回**：`Z` 或「撤回」逐条撤销盖印与挡墨操作，盖印会全额返还墨量。
- **验证**：顶栏「操作串验证」可以查看内置操作串的逐步核对结果，并在棋盘上演示；演示在副本上进行，不会改动你的进度。

## 关卡

1. **四角花**（6×6）：四枚角钩 + 一枚十字。铁锈 16 格、靛青 5 格都恰好用尽；右上、左下两枚必须翻面。
2. **护心**（6×6）：先铺 3×3 铁锈，用挡墨纸护住中心，再让靛青十字只染四臂；四条肘三格补角。叠色不对称，顺序错会得到焦褐而不是藤紫。

## 操作串

`operations/*.ops.txt` 是操作串的唯一事实来源，应用和命令行验证器共用同一份文本：

```
stamp hook rust at A6 rot 2 flip 1 cost 4 ink 12 status playing // 左下角钩（翻面）
mask C3 on                                                       // 给正中心贴挡墨纸
undo ink rust 12 status playing                                  // 撤回失败的一印
```

- `at <格>` 使用 `A1` 形式的坐标（列字母 + 行号）。
- `rot 0..3` 是顺时针 90° 的次数，`flip 1` 表示翻面。
- `expect` 字段（`cost` / `ink` / `status` / `new-clean` / `masked` / `reject ink|contact|state`）由验证器逐项核对；`reject` 表示这一印应被整次拒绝。
- 内置的两份操作串覆盖：翻面、墨量刚好、落在保留格判失败与撤回、墨量不足整次拒绝、挡墨纸保护与收回、结果可复现。

## 实现

```
src/
  core/
    types.ts         共享类型
    geometry.ts      孔的翻面/旋转与定位
    game.ts          纯函数规则引擎：预览、盖印、挡墨、撤回、判定
    mix.ts           叠色表的构造
    script.ts        操作串执行器
    script-format.ts 操作串文本解析与规范化
    validate.ts      关卡数据校验
    *.test.ts        Vitest 测试
  data/
    levels.ts        两关数据
    scripts.ts       从 operations/*.ops.txt 载入内置操作串
  ui/
    main.ts          界面状态与交互
    render.ts        Canvas 棋盘、缩略图与图标
    style.css        视觉样式
operations/          可验证的操作串文本
scripts/
  verify-ops.ts      命令行验证器
  e2e.mjs / screenshot.mjs  开发期的端到端与截图脚本（需要 Playwright）
```

规则引擎是纯函数：`previewStamp` 只读，`stamp` 先一次性检查墨量与接触数再整体提交，`undo` 通过每步快照恢复，所以“墨不足时整次不盖”和“撤回返还用量”都由同一套状态保证。
