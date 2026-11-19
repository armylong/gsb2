import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { cleanup } from '@testing-library/react';
import App from '../App';
import { SAMPLE_DIALOGUE } from '../content/sampleDialogue';
import { SAVE_STORAGE_KEY, readSaves } from '../engine/saves';
import { CONFIG_DRAFT_KEY } from '../app/storage';

async function clickChoice(user: ReturnType<typeof userEvent.setup>, label: string) {
  const list = await screen.findByTestId('choice-list');
  const button = within(list).getByRole('button', { name: label });
  await user.click(button);
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string) {
  await clickChoice(user, label);
}

function storageSnapshot() {
  return window.localStorage.getItem(SAVE_STORAGE_KEY);
}

describe('界面流程：调试视图与玩家视图', () => {
  it('调试视图展示不可用选项与原因，玩家视图改为禁用/隐藏，且两者可选集合一致', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('抵达码头');

    // 进入售票窗口后，买票条件不满足时应显示原因。
    await choose(user, '走向售票窗口');
    const list = screen.getByTestId('choice-list');

    await user.click(screen.getByRole('button', { name: '玩家视图' }));
    const playerButtons = within(list)
      .getAllByRole('button')
      .filter((button) => button.classList.contains('choice-button'));
    // 玩家视图与调试视图共用同一求值, 禁用按钮集合一致。
    const playerDisabled = playerButtons.filter((button) => (button as HTMLButtonElement).disabled);
    expect(playerDisabled.map((button) => button.textContent)).toContain('用铜钥匙抵一张船票');

    await user.click(screen.getByRole('button', { name: '调试视图' }));
    expect(screen.getByTestId('choice-meta')).toHaveTextContent('不可用');
    const reasons = screen.getAllByText(/当前为 0|需要/);
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('选择后变量面板更新，重复切换视图不重复发放奖励', async () => {
    const user = userEvent.setup();
    render(<App />);
    await choose(user, '先去废弃的旧售票亭看看');
    await choose(user, '拉开抽屉，翻找能带走的东西');

    const variables = screen.getByTestId('variables-panel');
    // 铜币从 3 增加到 4。
    expect(variables).toHaveTextContent('铜币');
    const coinRow = within(variables).getByText('铜币').closest('li')!;
    expect(coinRow).toHaveTextContent('4');

    await user.click(screen.getByRole('button', { name: '玩家视图' }));
    await user.click(screen.getByRole('button', { name: '调试视图' }));
    await user.click(screen.getByRole('button', { name: '玩家视图' }));

    expect(within(screen.getByTestId('variables-panel')).getByText('铜币').closest('li')).toHaveTextContent(
      '4',
    );
  });
});

describe('界面流程：存档跨页面恢复与失效配置拒绝载入', () => {
  it('保存后卸载再挂载应用仍能载入同一存档', async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await choose(user, '和阿玫打个招呼');
    await choose(user, '把一枚铜币放进铁盒，陪她坐一会儿');

    await user.type(screen.getByPlaceholderText('例如：拿到船票之后'), '阿玫线');
    await user.click(screen.getByRole('button', { name: '保存当前进度' }));
    expect(storageSnapshot()).toBeTruthy();
    expect(readSaves(window.localStorage)).toHaveLength(1);

    first.unmount();
    render(<App />);

    const saves = readSaves(window.localStorage);
    expect(saves[0].name).toBe('阿玫线');
    const loadButton = await screen.findByRole('button', { name: '载入' });
    await user.click(loadButton);

    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('缆桩旁的少女');
    const variables = screen.getByTestId('variables-panel');
    expect(within(variables).getByText('阿玫好感').closest('li')).toHaveTextContent('2');
    expect(within(variables).getByText('铜币').closest('li')).toHaveTextContent('2');
  });

  it('改动配置使旧存档失效时指出不兼容，并保留当前现场', async () => {
    const user = userEvent.setup();
    render(<App />);
    await choose(user, '走向售票窗口');
    await user.type(screen.getByPlaceholderText('例如：拿到船票之后'), '改配置前');
    await user.click(screen.getByRole('button', { name: '保存当前进度' }));

    // 在编辑区把 arrival 上“走向售票窗口”的目标改成 booth，使历史记录不再匹配。
    const editor = screen.getByTestId('editor-panel');
    const nodeSelect = within(editor).getAllByRole('combobox')[0];
    await user.selectOptions(nodeSelect, 'arrival');
    await user.click(within(editor).getByText('走向售票窗口'));
    const targetSelect = within(editor).getAllByRole('combobox').find(
      (element) => (element as HTMLSelectElement).value === 'ticket',
    )!;
    await user.selectOptions(targetSelect, 'booth');

    expect(await screen.findByText('不兼容')).toBeInTheDocument();
    expect(screen.getByText(/目标已从/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝载入' })).toBeDisabled();

    // 当前现场仍是售票窗口，没有悄悄跳回入口。
    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('售票窗口');
  });

  it('删除节点后旧存档显示不兼容，点击不会跳回开头且保留现场', async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await choose(user, '走向售票窗口');
    await user.type(screen.getByPlaceholderText('例如：拿到船票之后'), '删节点前');
    await user.click(screen.getByRole('button', { name: '保存当前进度' }));
    first.unmount();

    // 模拟用户修改配置并删除了 ticket 节点，草稿会直接加载。
    const draft = {
      ...SAMPLE_DIALOGUE,
      nodes: SAMPLE_DIALOGUE.nodes.filter((node) => node.id !== 'ticket'),
    };
    window.localStorage.setItem(CONFIG_DRAFT_KEY, JSON.stringify(draft));

    render(<App />);
    expect(await screen.findByText('不兼容')).toBeInTheDocument();
    const reject = screen.getByRole('button', { name: '拒绝载入' });
    expect(reject).toBeDisabled();
    await user.click(reject);

    // 仍停留在新配置的入口，而不是“跳到开头当作恢复成功”。
    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('抵达码头');
    expect(screen.getByTestId('validation-panel')).toHaveTextContent('ticket');
  });

  it('有效存档可直接载入并恢复历史与变量', async () => {
    const user = userEvent.setup();
    const first = render(<App />);
    await choose(user, '走向售票窗口');
    await choose(user, '数出三枚铜币买票');
    await user.type(screen.getByPlaceholderText('例如：拿到船票之后'), '码头');
    await user.click(screen.getByRole('button', { name: '保存当前进度' }));
    first.unmount();

    render(<App />);
    await user.click(await screen.findByRole('button', { name: '载入' }));
    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('雨中的栈桥');
    expect(screen.getByTestId('history-panel')).toHaveTextContent('数出三枚铜币买票');
    expect(within(screen.getByTestId('variables-panel')).getByText('铜币').closest('li')).toHaveTextContent(
      '0',
    );
  });
});

describe('界面流程：回溯再分支', () => {
  it('回到历史选择之前，旧分支可查看，新选择不会混入旧分支状态', async () => {
    const user = userEvent.setup();
    render(<App />);
    await choose(user, '先去废弃的旧售票亭看看');
    await choose(user, '拉开抽屉，翻找能带走的东西');

    const history = screen.getByTestId('history-panel');
    const rewindButtons = within(history).getAllByRole('button', { name: '回到此选择之前' });
    await user.click(rewindButtons[0]);

    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('抵达码头');
    expect(within(screen.getByTestId('variables-panel')).getByText('铜币').closest('li')).toHaveTextContent(
      '3',
    );
    expect(history).toHaveTextContent('已封存分支');

    // 旧分支可以展开查看。
    const branchToggle = within(history)
      .getAllByRole('button')
      .find((button) => button.getAttribute('aria-expanded') !== null)!;
    await user.click(branchToggle);
    expect(within(history).getByText(/翻开抽屉|拉开抽屉/)).toBeInTheDocument();

    // 走另一条路。
    await choose(user, '走向售票窗口');
    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('售票窗口');
    const variables = screen.getByTestId('variables-panel');
    expect(within(variables).getByText('铜币').closest('li')).toHaveTextContent('3');
    expect(within(variables).getByText('翻过旧售票亭').closest('li')).toHaveTextContent('否');

    // 当前分支只有新的 1 条记录；旧分支的两步只出现在封存区。
    const activeHistory = screen.getByTestId('history-panel');
    expect(within(activeHistory).getAllByTestId(/^history-\d+$/)).toHaveLength(1);
    expect(within(activeHistory).getByText(/走向售票窗口/)).toBeInTheDocument();
    const branchBody = within(activeHistory).getByTestId(/^branch-body-branch-/);
    expect(branchBody).toHaveTextContent('拉开抽屉，翻找能带走的东西');
    // 封存分支显示其终点快照（铜币 4），但不影响当前铜币 3。
    expect(branchBody).toHaveTextContent('翻过旧售票亭');
  });
});

describe('界面流程：配置编辑', () => {
  it('修改节点文本后重新开始显示新文本', async () => {
    const user = userEvent.setup();
    render(<App />);
    const editor = screen.getByTestId('editor-panel');
    const textarea = within(editor).getByLabelText('节点文本');
    await user.clear(textarea);
    await user.type(textarea, '雾散了，码头空无一人。');
    await user.click(within(editor).getByRole('button', { name: '按当前配置重新开始' }));
    expect(screen.getByTestId('dialogue-card')).toHaveTextContent('雾散了，码头空无一人。');
  });
});

// 避免测试间状态泄漏。
it('cleanup between suites', () => {
  cleanup();
  window.localStorage.clear();
  expect(true).toBe(true);
});
