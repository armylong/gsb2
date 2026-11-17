import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeImage, encodePng } from './imageIo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// 解码:上传 PNG/JPEG 原始字节,返回 RGBA 像素(base64)
app.post('/api/decode', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: '请求体为空,需要图片原始字节' });
      return;
    }
    const img = await decodeImage(req.body);
    res.json({
      width: img.width,
      height: img.height,
      data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString('base64'),
    });
  } catch (e) {
    res.status(400).json({ error: `图片解码失败: ${e instanceof Error ? e.message : String(e)}` });
  }
});

// 导出:接收 RGBA 像素(base64),返回 PNG
app.post('/api/export', express.json({ limit: '600mb' }), async (req, res) => {
  try {
    const { width, height, data } = req.body ?? {};
    if (typeof width !== 'number' || typeof height !== 'number' || typeof data !== 'string') {
      res.status(400).json({ error: '参数不完整: 需要 width, height, data(base64)' });
      return;
    }
    const png = await encodePng(new Uint8Array(Buffer.from(data, 'base64')), width, height);
    res.type('image/png').send(png);
  } catch (e) {
    res.status(400).json({ error: `PNG 编码失败: ${e instanceof Error ? e.message : String(e)}` });
  }
});

// 生产模式:托管 vite 构建产物(含 public/samples 示例素材)
const dist = path.resolve(__dirname, '../dist');
app.use(express.static(dist));

app.listen(PORT, () => {
  console.log(`[server] API 与静态资源: http://localhost:${PORT}`);
});
