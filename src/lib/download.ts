export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 等浏览器开始读取 blob 后再释放。
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（如局域网 http）没有 Clipboard API，退回旧法。
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function timestampSlug(time: number): string {
  return time.toFixed(1).replace('.', 'p');
}
