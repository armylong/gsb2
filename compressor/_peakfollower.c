/*
 * 峰值保持 / 独立释放检测器的 C 加速实现（与 dsp.py 标量状态机逐位等价）。
 * 通过 ctypes 调用；编译失败时 Python 侧自动回退到纯 numpy 实现。
 *
 * 接口：
 *   void peak_follower(const double *det, double *out, long n,
 *                      double a_att, double a_rel, long zero_limit)
 * det 中 -inf 表示数字静音（严格零样本）。
 */
#include <math.h>

void peak_follower(const double *det, double *out, long n,
                   double a_att, double a_rel, long zero_limit) {
    double held = -INFINITY;
    long zero_run = 0;
    for (long i = 0; i < n; i++) {
        double d = det[i];
        if (isinf(d) && d < 0.0) {
            zero_run++;
            if (isinf(held) && held < 0.0) {
                out[i] = -INFINITY;
                continue;
            }
            held -= a_rel;  /* 瞬时零样本：照常释放，不清空 */
            out[i] = held;
            if (zero_run >= zero_limit) {  /* 连续静音 => 真静音段 */
                held = -INFINITY;
                out[i] = -INFINITY;
            }
            continue;
        }
        zero_run = 0;
        if (isinf(held) && held < 0.0) {
            held = d;
        } else if (d >= held) {
            held += a_att * (d - held);
        } else {
            held -= a_rel;
        }
        out[i] = held;
    }
}
