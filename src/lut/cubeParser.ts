/**
 * 标准文本 .cube 三维色表解析器。
 *
 * 约定（固定，不猜测）：
 * - 仅支持三维表（LUT_3D_SIZE）。一维表（LUT_1D_SIZE）一律拒绝。
 * - 数据行每行 3 个浮点数，共 size^3 条；条目不足或超出都拒绝，不用部分数据凑合。
 * - 通道顺序：红色变化最快，其次绿色，最慢蓝色（Iridas/Adobe .cube 标准）。
 *   即第 (b*size^2 + g*size + r) 条对应网格点 (r, g, b)。
 * - 输入范围：DOMAIN_MIN/DOMAIN_MAX（每通道）或 LUT_3D_INPUT_RANGE（三通道统一）。
 *   缺省为 [0,1]。超出范围的输入在采样前按边界截断（clamp）。
 */

export interface Lut3D {
  /** 色表名称（TITLE），缺省为 "(未命名)" */
  name: string;
  /** 每维网格尺寸 N，总条目 N^3 */
  size: number;
  /** 输入范围下界（每通道，工作空间中的值） */
  domainMin: [number, number, number];
  /** 输入范围上界（每通道） */
  domainMax: [number, number, number];
  /** 网格数据，长度 N^3*3；索引 ((b*N + g) * N + r) * 3 + channel */
  data: Float32Array;
}

export class CubeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeParseError';
  }
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseFloats(tokens: string[], count: number, lineNo: number, what: string, offset = 1): number[] {
  if (tokens.length !== count + offset) {
    throw new CubeParseError(`第 ${lineNo} 行: ${what} 需要 ${count} 个数值,实际 ${tokens.length - offset} 个`);
  }
  const out: number[] = [];
  for (let i = offset; i < offset + count; i++) {
    const v = Number(tokens[i]);
    if (!NUMBER_RE.test(tokens[i]) || !Number.isFinite(v)) {
      throw new CubeParseError(`第 ${lineNo} 行: ${what} 含非法数值 "${tokens[i]}"`);
    }
    out.push(v);
  }
  return out;
}

export function parseCube(text: string): Lut3D {
  let title: string | null = null;
  let size: number | null = null;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let sawDomainMin = false;
  let sawDomainMax = false;
  const values: number[] = [];

  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    const tokens = line.split(/\s+/);
    const keyword = tokens[0].toUpperCase();

    if (keyword === 'TITLE') {
      const quoted = line.match(/TITLE\s+"([^"]*)"/i);
      const bare = line.match(/TITLE\s+(\S+)/i);
      title = quoted ? quoted[1] : bare ? bare[1] : '';
    } else if (keyword === 'LUT_1D_SIZE' || keyword === 'LUT_1D_INPUT_RANGE') {
      throw new CubeParseError(
        `第 ${lineNo} 行: 检测到 ${keyword},这是一维色表;本工具仅支持三维色表(LUT_3D_SIZE),拒绝载入`
      );
    } else if (keyword === 'LUT_3D_SIZE') {
      if (size !== null) throw new CubeParseError(`第 ${lineNo} 行: LUT_3D_SIZE 重复出现`);
      const n = Number(tokens[1]);
      if (tokens.length !== 2 || !Number.isInteger(n) || n < 2 || n > 256) {
        throw new CubeParseError(`第 ${lineNo} 行: LUT_3D_SIZE 必须是 2..256 的整数,实际为 "${tokens[1] ?? ''}"`);
      }
      size = n;
    } else if (keyword === 'DOMAIN_MIN') {
      const v = parseFloats(tokens, 3, lineNo, 'DOMAIN_MIN');
      domainMin = [v[0], v[1], v[2]];
      sawDomainMin = true;
    } else if (keyword === 'DOMAIN_MAX') {
      const v = parseFloats(tokens, 3, lineNo, 'DOMAIN_MAX');
      domainMax = [v[0], v[1], v[2]];
      sawDomainMax = true;
    } else if (keyword === 'LUT_3D_INPUT_RANGE') {
      const v = parseFloats(tokens, 2, lineNo, 'LUT_3D_INPUT_RANGE');
      domainMin = [v[0], v[0], v[0]];
      domainMax = [v[1], v[1], v[1]];
      sawDomainMin = true;
      sawDomainMax = true;
    } else if (NUMBER_RE.test(tokens[0])) {
      if (size === null) {
        throw new CubeParseError(`第 ${lineNo} 行: 数据出现在 LUT_3D_SIZE 声明之前,拒绝解析`);
      }
      const v = parseFloats(tokens, 3, lineNo, '数据行', 0);
      values.push(v[0], v[1], v[2]);
    } else {
      throw new CubeParseError(`第 ${lineNo} 行: 无法识别的内容 "${tokens[0]}",拒绝解析`);
    }
  }

  if (sawDomainMin !== sawDomainMax) {
    throw new CubeParseError('DOMAIN_MIN 与 DOMAIN_MAX 必须成对出现');
  }
  if (size === null) {
    throw new CubeParseError('缺少 LUT_3D_SIZE 声明,不是有效的三维色表');
  }
  const expected = size * size * size;
  const actual = values.length / 3;
  if (actual < expected) {
    throw new CubeParseError(`条目不足: ${size}^3 需要 ${expected} 条数据,实际只有 ${actual} 条,拒绝用部分数据生成结果`);
  }
  if (actual > expected) {
    throw new CubeParseError(`条目过多: ${size}^3 需要 ${expected} 条数据,实际有 ${actual} 条`);
  }
  for (let c = 0; c < 3; c++) {
    if (!(domainMin[c] < domainMax[c])) {
      throw new CubeParseError(
        `输入范围不合法: 通道 ${['R', 'G', 'B'][c]} 的下界 ${domainMin[c]} 必须小于上界 ${domainMax[c]}`
      );
    }
  }

  return {
    name: title ?? '(未命名)',
    size,
    domainMin,
    domainMax,
    data: new Float32Array(values),
  };
}
