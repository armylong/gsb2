import { COMBO_MAP } from '../game/combos';
import { buildEvidence, compatibleComboIds } from '../game/evidence';
import { PLATE_MAP } from '../game/plates';
import { store } from '../state/store';
import { h } from './dom';
import { confirmModal, toast } from './feedback';

function comboName(id: string): string {
  const combo = COMBO_MAP.get(id);
  if (!combo) return id;
  return combo.plates.map((p) => PLATE_MAP[p].name).join(' · ');
}

function scrollToReveal(): void {
  requestAnimationFrame(() =>
    document.getElementById('reveal')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  );
}

export async function handleSubmit(): Promise<void> {
  const p = store.progress;
  if (p.phase === 'submitted') return;
  if (!p.selected) {
    toast('请先在下方 20 种候选组合中点选一个答案');
    return;
  }

  const ev = buildEvidence(p);
  const compatible = compatibleComboIds(ev);
  const selectedCompatible = compatible.includes(p.selected);

  // 证据与选择矛盾：无论证据是否唯一都要明确拦截确认
  if (!selectedCompatible) {
    const body = h(
      'div',
      null,
      h('p', null, '你选中的组合与目前记录到的声纹证据不一致——按已试敲法的分析，它不可能产生你听到的声音。'),
      h('p', null, '可能是排除 / 选择时点错了。仍要按这个组合提交吗？'),
    );
    const ok = await confirmModal({
      title: '所选组合与证据矛盾',
      body,
      confirmText: '仍要提交',
      cancelText: '返回检查',
    });
    if (ok) {
      store.submit();
      scrollToReveal();
    }
    return;
  }

  if (compatible.length > 1) {
    const unexcluded = compatible.filter((id) => !p.excluded.includes(id));
    const list = h(
      'div.modal-combos',
      null,
      compatible.map((id) =>
        h(
          'li.chip',
          {
            style:
              'display:flex;width:100%;justify-content:space-between;font-size:13px;padding:7px 12px;',
          },
          h('span', { text: comboName(id) }),
          p.excluded.includes(id)
            ? h('span', { style: 'color:var(--ink-3);', text: '已被你排除' })
            : h('span', { style: 'color:var(--vermilion);font-weight:700;', text: '未排除' }),
        ),
      ),
    );

    const body = h(
      'div',
      null,
      h(
        'p',
        null,
        `严格的声纹证据上，仍有 ${compatible.length} 种组合在你已测试的敲法下完全相同，无法唯一确定——这就是“信息不足”。`,
      ),
      list,
      unexcluded.length === 1
        ? h(
            'p',
            {
              style: 'color:var(--teal-dark);',
              text: '你已手动排除其余组合：如果排除依据是试听栏学到的音高 / 余音（而非猜测），可以提交。',
            },
          )
        : h(
            'p',
            null,
            `其中还有 ${unexcluded.length} 种未被排除。建议回到敲击台，用提示为「★ 可唯一锁定」的敲法取证。`,
          ),
    );

    const ok = await confirmModal({
      title: '证据不足，不能唯一锁定',
      body,
      confirmText: unexcluded.length === 1 ? '依据听觉排除，仍提交' : '我知道是猜，仍要提交',
      cancelText: '再去取证',
    });
    if (ok) {
      store.submit();
      scrollToReveal();
    }
    return;
  }

  // 证据唯一且选择与证据一致
  store.submit();
  scrollToReveal();
  toast('证据链完整，已提交！', 1600);
}

export async function handleGiveUp(): Promise<void> {
  const ok = await confirmModal({
    title: '结束并核对真实摆放？',
    body: h(
      'div',
      null,
      h('p', null, '将直接公开木盒三格的真实铃片与鉴别讲解，本题会记为“已核对（未作答）”。'),
      h('p', { text: '题组固定不变，之后仍可「重玩本组」。' }),
    ),
    confirmText: '公开真相',
    cancelText: '继续推理',
    tone: 'teal',
  });
  if (ok) {
    store.revealWithoutAnswer();
    scrollToReveal();
  }
}
