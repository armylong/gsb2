# 双角色镜头缩放 / 平移实验台

同一屏放两个活动角色时, 用来测试**镜头缩放 vs 平移取舍**的 TypeScript + Canvas 实验台。
样例场景(三个几何角色 + 预设路径)全部在程序内生成, 无需外部素材。

## 本地启动

```bash
npm install
npm run dev          # 打开 http://localhost:5173 (自动唤起浏览器)
```

> **本机环境提示**: 当前 `.zshrc` 里 `/opt/homebrew/opt/node@22/bin` 优先于默认 node,
> 但该 node@22 因 simdjson 动态库版本不匹配无法启动 (`dyld: Library not loaded`)。
> 临时绕过: 每条命令前执行 `export PATH="/opt/homebrew/bin:$PATH"` (走可用的 node 26);
> 彻底修复: `brew reinstall node@22`, 或从 `.zshrc` 删掉那行 PATH(默认 node 已为 26)。

生产构建 / 预览:

```bash
npm run build        # tsc 类型检查 + vite 打包到 dist/
npm run preview
```

## 一条可运行的验证命令

```bash
npm run verify
```

该命令用 Node 直接执行 `scripts/verify.ts`(`node --experimental-strip-types`,
不依赖浏览器/DOM), 对纯逻辑核心做 7 组共 22 项断言:

1. **确定性** — 同 seed 同配置两次运行, 逐帧快照完全一致
2. **暂停单步可重复** — 逐次 `step()` 与一次 `runFull()` 的同 tick 结果完全相等
3. **钳制** — zoom 不越缩放范围; 视口不越平移范围(视口宽于活动范围时强制居中并报 `PAN_LIMIT`)
4. **超距裁切** — 目标间距超出镜头能力时出现 `MAX_ZOOM` 触限帧和带边信息的被裁角色
5. **帧率效果** — `per-tick` 平滑下 15/60fps 镜头位置发散; `exp` 帧率无关模式收敛一致
6. **名单与回放** — 空名单镜头冻结; 单角色不被裁; 离线录制与现场仿真一致
7. **边缘稳定** — 硬切模式实际中心 == 期望中心; 首帧直接 snap 无入画滑动

## 功能对照(对应需求)

| 需求 | 实现位置 / 操作 |
| --- | --- |
| 几何角色: 拖动 / 预设路径 / 切换跟随名单 | 实时页直接拖角色(松手后回到当前时刻的路径点); 右侧勾选跟随名单; 路径由确定性 PRNG 生成 (`src/core/scenario.ts`) |
| 可调安全区 / 缩放范围 / 水平垂直活动范围 | 右侧滑杆: 安全区 X/Y 边距、min/max zoom、平移范围宽高 |
| 超距时显示被裁的人和触发的限制 | 被裁角色在屏幕边缘显示红色标记 + `裁切: left/right/...`; 右上角徽标 `MAX_ZOOM / PAN_LIMIT_X / PAN_LIMIT_Y / MIN_ZOOM` |
| 边缘出入过渡稳定、暂停单步可重复 | 固定步长仿真, 墙钟只驱动累积器; 首帧 snap 不入画滑动; 每步按当前 zoom 重新钳制中心; 「单步」按钮与验证组 2 |
| 回放同时看轨迹和镜头边框、验证帧率 | 「回放 / 多帧率」页: 世界俯视图叠加 15/30/60fps 的镜头视口框、镜头中心轨迹和理想中心十字, 可单独开关 |

## 两种平滑模式(取舍测试的关键开关)

- **per-tick**: 每个固定步长吃同一插值比例 — 帧率越低镜头滞后越大, 用来暴露帧率相关问题
- **exp**: `alpha = 1 - exp(-rate·dt)`, 帧率无关 — 不同帧率在同一墙钟时间收敛到近似相同的镜头

## 架构

```
src/core/           纯逻辑, 不碰 DOM(可直接在 Node 验证)
  types.ts          共享类型
  math.ts           clamp/lerp/确定性 PRNG
  scenario.ts       样例场景与分段线性路径求值
  camera.ts         CameraRig: 安全区拟合、缩放/平移钳制、平滑、裁切诊断
  simulation.ts     固定步长仿真、快照序列、离线录制
src/render/
  renderer.ts       实时镜头视图(安全区框/轨迹/裁切标记/限制徽标)
  replay.ts         回放俯视图(多帧率镜头边框叠加)
src/main.ts         UI 绑定、拖动交互、固定步长主循环
scripts/verify.ts   Node 验证脚本
```

核心约定: 每个固定步长产出一条 `Snapshot`(角色位置 + 镜头中心/zoom/视口矩形/
期望镜头/裁切/触限), 实时渲染、回放、验证全部消费同一种快照, 保证三处看到的是同一个事实。
