/*
 * 取景插值核心（浏览器与 Node 通用，无 DOM 依赖）。
 * 数学实现与 framer/keyframes.py 保持一一对应，
 * tests/test_parity.py 会用 node 执行本文件做双实现一致性校验。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.FramerCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function cropSize(displayWidth, displayHeight) {
    const h = displayHeight - (displayHeight % 2);
    const w = (Math.floor((h * 9) / 16)) & ~1;
    if (w < 4 || w > displayWidth) {
      throw new Error(
        "显示尺寸 " + displayWidth + "x" + displayHeight +
        " 无法得到有效的 9:16 取景框");
    }
    return [w, h];
  }

  function maxX(displayWidth, cropW) {
    return displayWidth - cropW;
  }

  // 半值向上舍入，与 Python 端 math.floor(x + 0.5) 一致
  function roundHalfUp(v) {
    return Math.floor(v + 0.5);
  }

  function clampX(x, displayWidth, cropW) {
    const upper = maxX(displayWidth, cropW);
    if (x < 0) return 0;
    if (x > upper) return upper;
    return roundHalfUp(x);
  }

  function defaultKeyframes(displayWidth, cropW) {
    return [{ t: 0, x: clampX((displayWidth - cropW) / 2, displayWidth, cropW) }];
  }

  function normalizeKeyframes(keyframes, duration, displayWidth, cropW) {
    if (!Array.isArray(keyframes) || keyframes.length === 0) {
      throw new Error("至少需要一个关键点");
    }
    const cleaned = [];
    for (const kf of keyframes) {
      if (!kf || typeof kf.t !== "number" || typeof kf.x !== "number") {
        throw new Error("关键点格式错误：" + JSON.stringify(kf));
      }
      if (Number.isNaN(kf.t) || Number.isNaN(kf.x)) {
        throw new Error("关键点不能为 NaN");
      }
      if (kf.t < 0 || kf.t > duration + 1e-6) {
        throw new Error(
          "关键点时间 " + kf.t.toFixed(3) + "s 超出视频范围 0~" +
          duration.toFixed(3) + "s");
      }
      cleaned.push({
        t: Math.round(kf.t * 1000) / 1000,
        x: clampX(kf.x, displayWidth, cropW),
      });
    }
    cleaned.sort((a, b) => a.t - b.t);
    for (let i = 1; i < cleaned.length; i++) {
      if (Math.abs(cleaned[i].t - cleaned[i - 1].t) < 1e-6) {
        throw new Error("存在重复时间点 t=" + cleaned[i].t + "s");
      }
    }
    return cleaned;
  }

  function ease(u, easing) {
    if (easing === "linear") return u;
    return u * u * (3 - 2 * u); // smoothstep
  }

  function interpolate(keyframes, t, displayWidth, cropW, easing) {
    easing = easing || "smoothstep";
    const upper = maxX(displayWidth, cropW);
    const clip = (v) => Math.min(Math.max(v, 0), upper);
    if (t <= keyframes[0].t) return Math.round(clip(keyframes[0].x));
    if (t >= keyframes[keyframes.length - 1].t) {
      return Math.round(clip(keyframes[keyframes.length - 1].x));
    }
    for (let i = 0; i < keyframes.length - 1; i++) {
      const t1 = keyframes[i].t, x1 = keyframes[i].x;
      const t2 = keyframes[i + 1].t, x2 = keyframes[i + 1].x;
      if (t1 <= t && t <= t2) {
        const dt = t2 - t1;
        const u = dt === 0 ? 0 : Math.min(Math.max((t - t1) / dt, 0), 1);
        const x = clip(x1 + (x2 - x1) * ease(u, easing));
        return roundHalfUp(x);
      }
    }
    return keyframes[keyframes.length - 1].x;
  }

  function segmentExpr(t1, x1, t2, x2, easing) {
    const dt = t2 - t1;
    if (dt <= 0) return x1.toFixed(3);
    if (easing === "linear") {
      return "(" + x1.toFixed(3) + "+(" + (x2 - x1).toFixed(3) +
        ")*((t-" + t1.toFixed(3) + ")/" + dt.toFixed(6) + "))";
    }
    // 过滤器内表达式的逗号必须转义为 \,
    const u = "clip((t-" + t1.toFixed(3) + ")/" + dt.toFixed(6) + "\\,0\\,1)";
    const s = "(" + u + ")*(" + u + ")*(3-2*(" + u + "))";
    return "(" + x1.toFixed(3) + "+(" + (x2 - x1).toFixed(3) + ")*" + s + ")";
  }

  function buildXExpression(keyframes, displayWidth, cropW, easing) {
    easing = easing || "smoothstep";
    const upper = maxX(displayWidth, cropW);
    let inner;
    if (keyframes.length === 1) {
      inner = keyframes[0].x.toFixed(3);
    } else {
      inner = keyframes[keyframes.length - 1].x.toFixed(3);
      for (let i = keyframes.length - 2; i > 0; i--) {
        const seg = segmentExpr(
          keyframes[i].t, keyframes[i].x,
          keyframes[i + 1].t, keyframes[i + 1].x, easing);
        inner = "if(lt(t\\," + keyframes[i + 1].t.toFixed(3) + ")\\," +
          seg + "\\," + inner + ")";
      }
      const first = segmentExpr(
        keyframes[0].t, keyframes[0].x,
        keyframes[1].t, keyframes[1].x, easing);
      inner = "if(lt(t\\," + keyframes[1].t.toFixed(3) + ")\\," +
        first + "\\," + inner + ")";
      inner = "if(lt(t\\," + keyframes[0].t.toFixed(3) + ")\\," +
        keyframes[0].x.toFixed(3) + "\\," + inner + ")";
    }
    return "clip(" + inner + "\\,0\\," + upper + ")";
  }

  return {
    cropSize, maxX, clampX, defaultKeyframes,
    normalizeKeyframes, interpolate, buildXExpression,
  };
});
