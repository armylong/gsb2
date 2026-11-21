# 三向平铺投影权重调参台（Triplanar Weight Workbench）

用 TypeScript + three.js 在本地调试三向平铺（triplanar mapping）投影权重，
重点检查水平/竖直/斜面在转角处的接合。网格与纹理全部在程序里生成，无外部资源。

## 环境要求

- Node.js ≥ 20（开发机默认的 Homebrew node@22 若因 simdjson 动态库损坏无法启动，
  可改用 `node@20`：`export PATH="/opt/homebrew/opt/node@20/bin:$PATH"`）
- 依赖通过 `npm install` 安装（three、vite、typescript、tsx）

## 本地启动

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址（默认 http://127.0.0.1:5173/ ，会自动唤起浏览器）。
生产构建：`npm run build`（先做 `tsc --noEmit` 类型检查，再用 Vite 打包到 `dist/`）。

## 一条可运行的验证命令

```bash
npm test
```

该命令用 Node 内置测试运行器（`tsx --test`，无需额外框架）执行 16 个测试，
覆盖 CPU 权重参考实现（归一化、主导轴、陡度锐化、轴偏置、零法线回退、投影 UV）
和四个程序网格的法线朝向与闭合性。GPU 着色器中的权重公式与
`src/triplanar.ts` 的 CPU 实现逐行对应，测试即两者的一致性基准。

可选的浏览器端冒烟验证（需要本机装有 Google Chrome，使用其 headless + SwiftShader）：

```bash
# 终端 A：先启动 dev server
npm run dev
# 终端 B：页面加载/渲染诊断 与 全交互（切模式、点选、空间切换）验证
/opt/homebrew/opt/node@26/bin/node scripts/cdp-check.mjs
/opt/homebrew/opt/node@26/bin/node scripts/cdp-interact.mjs
```

## 功能与需求对照

1. **连续网格 + 程序纹理**（`src/geometry.ts`、`src/textures.ts`）
   - 斜坡台（水平底面 / 45° 斜面 / 水平顶面 / 竖直侧壁 / 端盖）、
     凹转角（地板+两墙，三轴交线）、四分之一圆弯面（平滑法线连续过渡）、立方体；
   - 诊断纹理由 Canvas 程序生成：网格、每格轴名与整数坐标、u/v 方向箭头、
     四角 R/G/B/Y 旋转色标，翻转镜像一眼可辨。
2. **三轴投影单独看 / 混合 / 权重可视化**（`src/shaders.ts`）
   - 显示模式：混合、仅 X、仅 Y、仅 Z、权重可视化（1D LUT 热力色）、法线可视化。
3. **世界固定 / 物体固定纹理**
   - 着色器同时接收世界空间与物体空间的位置/法线，UI 一键切换 `spaceMode`；
   - TransformControls 可平移/旋转模型，两种附着模式的差异可直接对比。
4. **反向法线与轴界面混合区**
   - 混合区（主导权重低于可调阈值）叠品红斜纹，阈值滑杆可调；
   - 背面（`gl_FrontFacing == false`）叠红色反向斜纹，另提供一块刻意翻转法线的
     演示三角片；过渡陡度 `sharpness`（1–16）实时调节，公式为
     线性归一化权重取 `sharpness` 次幂后二次归一化。
5. **点选诊断**
   - 点击表面在侧栏读出：附着空间、采样点、法线、面索引、三个轴各自的
     权重/符号/采样 UV、主导轴、是否处于混合区、是否背面；
     场景中同时放置带轴名（X/Y/Z）与“反向”文字的标记精灵。

## 目录结构

```
src/
  triplanar.ts   CPU 权重参考实现（测试基准，与 GLSL 同公式）
  shaders.ts     triplanar ShaderMaterial（顶点/片元 GLSL、模式常量）
  geometry.ts    四个程序生成的测试网格
  textures.ts    诊断纹理与权重 LUT（Canvas/DataTexture 程序生成）
  main.ts        场景、UI 绑定、TransformControls、射线点选诊断
tests/
  weights.test.ts  npm test 的 16 个测试
scripts/
  cdp-check.mjs     headless Chrome 加载/渲染诊断
  cdp-interact.mjs  headless Chrome 全交互冒烟验证
```
