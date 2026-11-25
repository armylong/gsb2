import { h } from './dom';

export function toast(message: string, duration = 2200): void {
  let wrap = document.querySelector<HTMLDivElement>('.toast-wrap');
  if (!wrap) {
    wrap = h('div.toast-wrap') as HTMLDivElement;
    document.body.appendChild(wrap);
  }
  const el = h('div.toast', { role: 'status' }, message);
  wrap.appendChild(el);
  window.setTimeout(() => {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    window.setTimeout(() => el.remove(), 320);
  }, duration);
}

export interface ConfirmOptions {
  title: string;
  body?: Node | string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'vermilion' | 'teal';
}

/** 返回 true = 确认，false = 取消 / 关闭。 */
export function confirmModal(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = h('div.modal-overlay');
    const close = (value: boolean) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey);

    const confirmBtn = h(
      'button.btn.btn-primary',
      {
        style: opts.tone === 'teal'
          ? 'background:linear-gradient(160deg,#3a948a,#22615a);border-color:#22615a;box-shadow:0 6px 16px -6px rgba(47,125,116,.7);width:auto;'
          : 'width:auto;',
        onClick: () => close(true),
      },
      opts.confirmText ?? '确定',
    );
    const cancelBtn = h(
      'button.btn.btn-ghost',
      { onClick: () => close(false) },
      opts.cancelText ?? '返回',
    );

    const bodyNode =
      typeof opts.body === 'string' ? h('p', { text: opts.body }) : (opts.body ?? null);

    const modal = h(
      'div.modal',
      { role: 'dialog', 'aria-modal': 'true' },
      h('h3', null, '⚠️ ', opts.title),
      bodyNode as Node,
      h(
        'div.modal-actions',
        null,
        cancelBtn,
        confirmBtn,
      ),
    );
    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}
