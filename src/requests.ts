/**
 * "只保留最新请求"的门控。
 * 每次发起提取取一个递增 id；结果返回时只有 id 等于当前最新值才被接受，
 * 过期结果（即使更晚完成）一律丢弃。
 */
export class LatestGate {
  private current = 0;

  /** 发起新请求，返回其 id。此前所有 id 立即过期。 */
  next(): number {
    return ++this.current;
  }

  /** 该 id 是否仍是当前最新请求。 */
  isLatest(id: number): boolean {
    return id === this.current;
  }

  /** 当前最新 id（0 表示尚未发起请求）。 */
  get latest(): number {
    return this.current;
  }
}
