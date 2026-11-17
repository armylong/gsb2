/**
 * 本地 HLS 素材服务 + 可开关的故障模拟。
 * 零依赖（纯 Node http），只服务 media/ 目录下的文件。
 *
 * 接口：
 *   GET    /api/health            健康检查
 *   GET    /api/faults            当前故障规则与限速
 *   PUT    /api/faults            整体替换 { rules: [...], throttleKbps: n }
 *   DELETE /api/faults            清除全部规则与限速
 *   GET    /api/segments          列出 media/ 下所有分片（供界面选择规则作用对象）
 *   GET    /media/**              静态素材（应用故障规则）
 *
 * 规则：{ id?, pattern, type: 'delay'|'fail-once'|'fail-always', delayMs? }
 *   pattern 为相对路径子串，例如 "segment_005.ts" 或 "v2/"。
 * 关闭规则后，后续请求立即恢复正常，素材文件本身从不被修改。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8791);
const MEDIA_ROOT = path.resolve(__dirname, '..', 'media');

const MIME = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.aac': 'audio/aac',
};

/** @type {{id:number, pattern:string, type:string, delayMs:number}[]} */
let rules = [];
let throttleKbps = 0;
let ruleSeq = 1;
/** fail-once 已触发记录：`${ruleId}:${relPath}` */
const firedOnce = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeRule(r) {
  const rule = {
    id: ruleSeq++,
    pattern: String(r.pattern || '').trim(),
    type: String(r.type || ''),
    delayMs: Math.max(0, Number(r.delayMs) || 0),
  };
  if (!rule.pattern) throw new Error('规则缺少作用对象 pattern');
  if (!['delay', 'fail-once', 'fail-always'].includes(rule.type)) {
    throw new Error(`未知规则类型: ${rule.type}`);
  }
  if (rule.type === 'delay' && rule.delayMs <= 0) rule.delayMs = 2000;
  return rule;
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/faults' && req.method === 'GET') {
    return sendJson(res, 200, { rules, throttleKbps });
  }
  if (pathname === '/api/faults' && req.method === 'PUT') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      rules = (body.rules || []).map(normalizeRule);
      throttleKbps = Math.max(0, Number(body.throttleKbps) || 0);
      firedOnce.clear();
      return sendJson(res, 200, { rules, throttleKbps });
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }
  if (pathname === '/api/faults' && req.method === 'DELETE') {
    rules = [];
    throttleKbps = 0;
    firedOnce.clear();
    return sendJson(res, 200, { rules, throttleKbps });
  }
  if (pathname === '/api/segments' && req.method === 'GET') {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 4 || out.length >= 500) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (/\.(ts|m4s)$/.test(e.name)) out.push(path.relative(MEDIA_ROOT, full));
      }
    };
    walk(MEDIA_ROOT, 0);
    return sendJson(res, 200, { segments: out.sort() });
  }
  return sendJson(res, 404, { error: 'unknown api' });
}

/** 按限速把文件写入响应（仅分片限速，清单保持即时，便于观察分片行为）。
 *  分片很小（约 1MB），直接读入内存后按令牌桶节奏写出，行为可预期。 */
function streamThrottled(req, res, file) {
  const buf = fs.readFileSync(file);
  const bytesPerMs = (throttleKbps * 1024) / 8 / 1000;
  const chunkSize = 16 * 1024;
  const chunkMs = chunkSize / bytesPerMs;
  let offset = 0;
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    const end = Math.min(offset + chunkSize, buf.length);
    const chunk = buf.subarray(offset, end);
    offset = end;
    if (offset >= buf.length) {
      clearInterval(timer);
      res.end(chunk);
    } else {
      res.write(chunk);
    }
  }, chunkMs);
  // 客户端断开（如 hls.js 取消请求）时停止发送
  res.on('close', () => clearInterval(timer));
}

async function serveMedia(req, res, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/media\//, ''));
  const file = path.resolve(MEDIA_ROOT, rel);
  if (file !== MEDIA_ROOT && !file.startsWith(MEDIA_ROOT + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }

  // 应用故障规则（按声明顺序，全部命中都生效）
  for (const rule of rules) {
    if (!rel.includes(rule.pattern)) continue;
    if (rule.type === 'fail-always') {
      return sendJson(res, 500, { error: `fault injected: ${rule.pattern} 持续不可用` });
    }
    if (rule.type === 'fail-once') {
      const key = `${rule.id}:${rel}`;
      if (!firedOnce.has(key)) {
        firedOnce.add(key);
        return sendJson(res, 500, { error: `fault injected: ${rule.pattern} 首次请求失败` });
      }
    }
    if (rule.type === 'delay') {
      await sleep(rule.delayMs);
    }
  }

  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    /* not found */
  }
  if (!stat || !stat.isFile()) {
    return sendJson(res, 404, { error: `不存在: /media/${rel}` });
  }

  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  const isSegment = ext === '.ts' || ext === '.m4s';
  if (throttleKbps > 0 && isSegment) {
    streamThrottled(req, res, file);
  } else {
    fs.createReadStream(file).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    handleApi(req, res, pathname).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  if (pathname.startsWith('/media/') && req.method === 'GET') {
    serveMedia(req, res, pathname).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[server] 素材目录: ${MEDIA_ROOT}`);
  console.log(`[server] 监听 http://localhost:${PORT}  (GET /api/health)`);
});
