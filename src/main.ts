import { App } from './app';
import { v3 } from './math/vector';
import type { AABB } from './math/aabb';

const app = new App();
app.start();

// 调试与验证入口，便于在控制台 / 自动化里直接驱动打包后的真实求解器
declare global {
  interface Window {
    cameraDemo: App;
    /** 用自定义盒几何跑一帧相机求解，返回求解结果（用于近裁面九点等单元级验证） */
    __camSolve: (opts: {
      pivot: { x: number; y: number; z: number };
      yaw: number;
      pitch: number;
      desired: number;
      radius: number;
      near: number;
      boxes: AABB[];
    }) => unknown;
  }
}
window.cameraDemo = app;
window.__camSolve = ({ pivot, yaw, pitch, desired, radius, near, boxes }) => {
  return app.runSolverProbe(v3.create(pivot.x, pivot.y, pivot.z), yaw, pitch, desired, radius, near, boxes);
};
