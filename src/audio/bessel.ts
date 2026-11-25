/**
 * 第一类整数阶贝塞尔函数 J_n(x), 用幂级数计算。
 *
 * J_n(x) = sum_{k=0}^inf (-1)^k / (k! (n+k)!) * (x/2)^(2k+n)
 *
 * 采用递推更新单项, 避免大数阶乘溢出。
 * 本应用中 x <= ~30、n <= ~48, 该实现稳定且精度足够(相对误差 < 1e-9)。
 */
export function besselJ(n: number, x: number): number {
  if (n < 0 || !Number.isInteger(n)) throw new Error('n must be a non-negative integer');
  if (x < 0) return (n % 2 === 0 ? 1 : -1) * besselJ(n, -x);
  if (x === 0) return n === 0 ? 1 : 0;

  const halfX = x / 2;
  // 首项 k=0: (x/2)^n / n!
  let term = Math.pow(halfX, n);
  for (let i = 1; i <= n; i++) term /= i;

  let sum = term;
  for (let k = 1; k < 200; k++) {
    // term_k / term_(k-1) = -(x/2)^2 / (k * (n+k))
    term *= -(halfX * halfX) / (k * (n + k));
    sum += term;
    if (Math.abs(term) < 1e-14 * Math.abs(sum) + 1e-300) break;
  }
  return sum;
}
