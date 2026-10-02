import usageLine from '../../src/lib/usage.js';

/** In-memory session files: `files` maps a file name under sessions/ to its lines. */
const fakeIo = (files) => ({
  readdir: async () => {
    if (!files)
      throw Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
    return Object.keys(files);
  },
  readFile: async (file) => {
    const name = Object.keys(files).find((key) => file.endsWith(key));
    return files[name].join('\n');
  },
});

const run = (files, options = { model: 'gpt-6-luna' }) =>
  usageLine({ codexHome: '/codex', ...options }, fakeIo(files));

const usage = (input, cached, output) =>
  JSON.stringify({
    type: 'event',
    payload: {
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
        },
      },
    },
  });

describe('usageLine', () => {
  it('summarizes tokens and cost', async () => {
    expect(
      await run(
        { 'a.jsonl': [usage(120_400, 98_100, 5_200)] },
        { model: 'gpt-6-luna', effort: 'medium' },
      ),
    ).toBe('gpt-6-luna (medium) · 120.4k input, 98.1k cached · 5.2k output · ≈ $0.0058');
  });

  it('uses the last running total, across files in name order', async () => {
    const files = {
      'b.jsonl': [usage(3000, 0, 300)],
      'a.jsonl': [usage(1000, 0, 100), usage(2000, 0, 200)],
    };
    expect(await run(files)).toContain('3.0k input');
  });

  it('ignores files that are not .jsonl', async () => {
    expect(await run({ 'a.log': [usage(1, 0, 1)] })).toBeUndefined();
  });

  it('returns nothing when no session recorded usage', async () => {
    expect(await run({ 'a.jsonl': [JSON.stringify({ hello: 1 })] })).toBeUndefined();
  });

  it('reads sessions nested in dated folders', async () => {
    expect(await run({ '2026/10/02/run.jsonl': [usage(4000, 0, 400)] })).toContain('4.0k input');
  });

  it('rejects when there is no sessions folder (the caller treats usage as optional)', async () => {
    await expect(run(undefined)).rejects.toThrow(/ENOENT/);
  });
});
