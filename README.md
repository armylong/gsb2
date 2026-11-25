# 矢量遮罩预览(Vector Mask Preview)

纯 TypeScript + 浏览器 Canvas 实现的双层变换矢量遮罩核对工具。用来解决一个具体问题:
镂空图案套进两层各自带平移/旋转、且填充规则可能不同的遮罩后,**画面上看到的区域**与
**鼠标实际点中的位置**对不上。

核心做法: 渲染与命中测试共用同一套几何真值(曲线自适应展平 + 同一条矩阵坐标链),
从根上消除「画的是一套、算的是另一套」。

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # 类型检查 + 产物到 dist/
npm run test:geo   # Node 侧几何规则断言
```

浏览器端到端测试(需要本机 Chrome):

```bash
npm run dev                              # 先起 dev server
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/vmp-chrome about:blank
npm run test:browser    # 像素级: 填充规则 / 命中与渲染一致 / 导出 PNG
npm run test:interact   # 真实 CDP 指针与键盘: 拖动跟随 / 点击裁定 / 视图切换
```

## 五项需求的落点

1. **镂空/重叠/自交小图 + 两层可拖动旋转的遮罩, 每层可选填充规则**
   - 内容含: 曲线 blob、pentagram 自交五角星(`{5/2}` 折线)、同向重叠双圆;
   - 遮罩 A(父, 板+方孔+圆孔)、遮罩 B(子, 旋转盖板+圆孔);
   - 每层及每个图形都可独立切换 `nonzero`(方向计数)/ `evenodd`(奇偶);
   - 手柄拖动平移、上方圆点拖动旋转, 也支持方向键(Alt+方向键旋转, Shift 大步进)。

2. **父层裁掉的部分子层不能重新打开; 移动父层子层按父层坐标一起移动**
   - 渲染用 canvas 嵌套 `clip()`, 天然是交集, B 永远无法在 A 的孔里放行;
   - 数据模型里 B 只存「B 局部 → A 局部」矩阵, B 的世界矩阵 = `A · B`,
     移动 A 时 B 自动跟随(有端到端测试断言两者屏幕位移逐像素一致);
   - 命中侧同样按 `图形命中 ∩ A 放行 ∩ B 放行` 判定。

3. **原轮廓 / 单层遮罩 / 最终结果三视图, 内容坐标与指针对应**
   - 顶部四档切换(原轮廓、仅 A、仅 B、最终), 所有视图共用同一个 `view` 取景矩阵和
     同一条 `设备 → 根 → 各层局部` 逆矩阵链, HUD 实时显示指针在根/内容/A/B 四个空间的坐标。

4. **点击交叠区显示最上层实际可见图形, 并解释每个遮罩的放行/裁定; 透明洞穿透**
   - 命中面板分别给出: 几何最上层命中、遮罩放行后**实际可见**的最上层图形、
     每层的 `winding`/交点数与 inside/outside/boundary, 以及「换成另一种规则会怎样」;
   - 孔内/外部不命中任何图形, 点击会穿透到下层或背景。

5. **指定分辨率导出透明 PNG + 自带易弄反填充规则的检查例子**
   - 侧栏输入宽高即可导出; 导出走独立离屏 canvas, 无棋盘/手柄/遮罩底色, 只保留裁剪结果;
   - 工具栏「加载填充规则陷阱样例」: 方块外框与内孔**同方向**,
     `nonzero` 会把孔填平、`evenodd` 仍是孔 —— 一键切换即可核对。

## 关键设计: 为什么看到的和点中的能对上

```
src/core/geometry/path.ts    曲线展平 + 射线法(同时算 winding 与 crossings) + 边界容差
src/core/geometry/matrix.ts  列主序仿射矩阵, 与 canvas/DOMMatrix 字段一致
src/core/scene/              场景模型与示例路径(含陷阱)
src/core/hitTest.ts          命中真值: 图形/遮罩分层探测, 输出每层解释
src/render/renderer.ts       同一 VectorPath 同时喂给 Path2D(画)和射线法(算)
src/render/exporter.ts       离屏透明 PNG
src/ui/controller.ts         指针 → 逆矩阵 → 根坐标, 拖动/旋转/缩放
src/core/selftest.ts         几何断言 + 与 canvas 原生 isPointInPath 的网格交叉验证
```

- `Path2D` 与射线判定由同一个 `VectorPath` 对象生成, 不存在两套几何;
- 浏览器自检会对采样网格逐点比对自研判定与原生 `isPointInPath(path, rule)`,
  端到端测试再把 `hitTest` 结果与导出 PNG 的实际 alpha 逐点比对(跳过抗锯齿边缘像素);
- 边界点(压在轮廓边上)单独标记为 `boundary`, 与 canvas「边上按填充处理」的口径一致。

## 目录

```
src/   应用源码
test/  geo.test.ts(Node 几何) / browser-check.mjs(像素) / interact-check.mjs(交互)
tmp/   测试产物与截图(gitignore)
```
