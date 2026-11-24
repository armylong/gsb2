// 模拟核心测试:node test/sim.test.mjs
import { Board, RED, GREEN, BLUE } from '../dist/model.js';
import { simulate, traceReceiver } from '../dist/sim.js';
import { presetCombine, presetLoop, GRID_W } from '../dist/presets.js';

let failed = 0;
function check(name, cond) {
  console.log((cond ? '✔' : '✘') + ' ' + name);
  if (!cond) failed++;
}
const seg = (x, y, d) => (y * GRID_W + x) * 4 + d;

// ---- 盘面1:颜色合成 ----
{
  const b = new Board(GRID_W, 9);
  presetCombine(b);
  const r = simulate(b);
  const recv = (x, y) => r.receiverMask.get(`${x},${y}`) ?? 0;

  check('合并后向东光段为黄(红+绿)', (r.segMask.get(seg(4, 3, 1)) ?? 0) === (RED | GREEN));
  check('交叉点(5,3)横向是黄、纵向是蓝,互不干扰',
    (r.segMask.get(seg(5, 3, 1)) ?? 0) === (RED | GREEN) && (r.segMask.get(seg(5, 3, 0)) ?? 0) === BLUE);
  check('接收板(1,0)收到纯红', recv(1, 0) === RED);
  check('接收板(5,0)收到纯蓝', recv(5, 0) === BLUE);
  check('接收板(2,7)收到黄', recv(2, 7) === (RED | GREEN));
  check('接收板(7,6)收到黄(分束后的光到达)', recv(7, 6) === (RED | GREEN));
  check('接收板(10,3)收到黄', recv(10, 3) === (RED | GREEN));
  check('盘面1无循环', r.loopCells.size === 0);

  const t = traceReceiver(r, b, '10,3');
  check('回看(10,3)来源为红、绿两个发光块', t.sources.has('0,3') && t.sources.has('2,0') && t.sources.size === 2);
  check('回看包含合并光段(4,3)', t.segs.has(seg(4, 3, 1)));

  // 换色:把(2,0)绿光块改成蓝光 -> (10,3) 实收变为品红,要求黄 -> 不满足
  b.get(2, 0).color = BLUE;
  const r2 = simulate(b);
  check('换色后(10,3)实收变品红(红+蓝)', (r2.receiverMask.get('10,3') ?? 0) === (RED | BLUE));

  // 删除分束块(7,3) -> (7,6) 无光
  b.delete(7, 3);
  const r3 = simulate(b);
  check('删除分束块后(7,6)无光', (r3.receiverMask.get('7,6') ?? 0) === 0);
}

// ---- 盘面2:反射循环 ----
{
  const b = new Board(GRID_W, 9);
  presetLoop(b);
  const r = simulate(b);
  check('模拟有限步内结束', !r.truncated && r.steps < 200000);
  check('检测到封闭回路', r.loopCells.size > 0);
  check('回路包含四个角', ['3,2', '3,6', '7,6', '7,2'].every(k => r.loopCells.has(k)));
  check('离开回路的分束仍点亮接收板(5,7)', (r.receiverMask.get('5,7') ?? 0) === GREEN);

  const t = traceReceiver(r, b, '5,7');
  check('回看(5,7)来源是绿发光块(5,0)', t.sources.has('5,0'));

  // 旋转一块镜面 -> 回路被打破,回路标记消失
  b.get(3, 2).rot = 1;
  const r2 = simulate(b);
  check('旋转镜面后回路消失', r2.loopCells.size === 0);
}

process.exit(failed ? 1 : 0);
