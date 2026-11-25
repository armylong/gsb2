import { describe, expect, it } from 'vitest';
import { runSelfTests } from '../src/selftestCore';

describe('local scrub verification', () => {
  it('all browser-independent checks pass', async () => {
    const results = await runSelfTests();
    const failed = results.filter((result) => !result.ok);
    for (const result of failed) console.error(result.name, result.detail);
    expect(failed).toEqual([]);
  });
});
