import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import usageLine from '../src/usage.js';

const home = async (files) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'usage-'));
  for (const [name, lines] of Object.entries(files)) {
    const file = path.join(dir, 'sessions', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Array.isArray(lines) ? lines.join('\n') : lines);
  }
  return dir;
};

const usage = (input, cached, output) =>
  JSON.stringify({
    type: 'event',
    payload: {
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      },
    },
  });

describe('usageLine', () => {
  it('summarizes tokens and cost', async () => {
    const codexHome = await home({ 'a.jsonl': [usage(120_400, 98_100, 5_200)] });
    expect(await usageLine({ codexHome, model: 'gpt-6-luna', effort: 'medium' })).toBe(
      'gpt-6-luna (medium) · 120.4k input, 98.1k cached · 5.2k output · ≈ $0.0058',
    );
  });

  it('prices cached input at the cached rate and the rest at the input rate', async () => {
    const codexHome = await home({ 'a.jsonl': [usage(1_000_000, 400_000, 100_000)] });
    // 600k * $2 + 400k * $0.2 + 100k * $10 = 1.2 + 0.08 + 1.0 = $2.28 (gpt-6-sol)
    expect(await usageLine({ codexHome, model: 'gpt-6-sol' })).toContain('≈ $2.28');
  });

  it('prices each known model', async () => {
    const codexHome = await home({ 'a.jsonl': [usage(1_000_000, 0, 1_000_000)] });
    expect(await usageLine({ codexHome, model: 'gpt-6-astra' })).toContain('≈ $60.00');
    expect(await usageLine({ codexHome, model: 'gpt-6-sol' })).toContain('≈ $12.00');
    expect(await usageLine({ codexHome, model: 'gpt-6-luna' })).toContain('≈ $0.60');
  });

  it('uses four decimals below one cent and two from one cent', async () => {
    const small = await home({ 'a.jsonl': [usage(2000, 0, 0)] });
    expect(await usageLine({ codexHome: small, model: 'gpt-6-luna' })).toContain('≈ $0.0002');
    const big = await home({ 'a.jsonl': [usage(1_000_000, 0, 0)] });
    expect(await usageLine({ codexHome: big, model: 'gpt-6-sol' })).toContain('≈ $2.00');
  });

  it('formats small counts without a suffix and large ones with k', async () => {
    const codexHome = await home({ 'a.jsonl': [usage(999, 0, 1000)] });
    const line = await usageLine({ codexHome, model: 'gpt-6-luna' });
    expect(line).toContain('999 input, 0 cached');
    expect(line).toContain('1.0k output');
  });

  it('omits the cost for a model it has no price for, and the effort when not given', async () => {
    const codexHome = await home({ 'a.jsonl': [usage(1000, 0, 100)] });
    expect(await usageLine({ codexHome, model: 'gpt-9-unknown' })).toBe(
      'gpt-9-unknown · 1.0k input, 0 cached · 100 output',
    );
  });

  it('uses the last running total, across files in name order', async () => {
    const codexHome = await home({
      'b.jsonl': [usage(3000, 0, 300)],
      'a.jsonl': [usage(1000, 0, 100), usage(2000, 0, 200)],
    });
    expect(await usageLine({ codexHome, model: 'gpt-6-luna' })).toContain('3.0k input');
  });

  it('finds the total at any depth and ignores lines without it', async () => {
    const codexHome = await home({
      'a.jsonl': [
        '',
        JSON.stringify({ type: 'message', text: 'hello' }),
        JSON.stringify({ a: { b: { c: JSON.parse(usage(10, 0, 5)).payload.info } } }),
        '',
      ],
    });
    expect(await usageLine({ codexHome, model: 'gpt-6-luna' })).toContain('10 input');
  });

  it('keeps the earlier total when a later line mentions the key without a value', async () => {
    const codexHome = await home({
      'a.jsonl': [usage(500, 0, 50), JSON.stringify({ info: { total_token_usage: null } })],
    });
    expect(await usageLine({ codexHome, model: 'gpt-6-luna' })).toContain('500 input');
  });

  it('ignores files that are not .jsonl', async () => {
    const codexHome = await home({ 'a.log': [usage(1, 0, 1)] });
    expect(await usageLine({ codexHome, model: 'gpt-6-luna' })).toBeUndefined();
  });

  it('returns nothing when no session recorded usage', async () => {
    const codexHome = await home({ 'a.jsonl': [JSON.stringify({ hello: 1 })] });
    expect(await usageLine({ codexHome, model: 'gpt-6-luna' })).toBeUndefined();
  });

  it('reads sessions nested in dated folders', async () => {
    const codexHome = await home({ '2026/10/02/run.jsonl': [usage(4000, 0, 400)] });
    expect(await usageLine({ codexHome, model: 'gpt-6-luna' })).toContain('4.0k input');
  });

  it('rejects when there is no sessions folder (the caller treats usage as optional)', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'usage-empty-'));
    await expect(usageLine({ codexHome, model: 'gpt-6-luna' })).rejects.toThrow(/ENOENT/);
  });

  it('rejects on a truncated JSON line', async () => {
    const codexHome = await home({ 'a.jsonl': ['{"total_token_usage": {"input_tok'] });
    await expect(usageLine({ codexHome, model: 'gpt-6-luna' })).rejects.toThrow(SyntaxError);
  });
});
