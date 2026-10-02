import { lastUsage } from '../../src/lib/usage-log.js';

const total = (input, cached = 0, output = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
});
const line = (value) => JSON.stringify(value);

describe('lastUsage', () => {
  it('finds the running total', () => {
    expect(
      lastUsage([line({ payload: { info: { total_token_usage: total(10, 4, 2) } } })]),
    ).toEqual(total(10, 4, 2));
  });

  it('uses the last total, since it is a running one', () => {
    const lines = [line({ total_token_usage: total(1) }), line({ total_token_usage: total(3) })];
    expect(lastUsage(lines)).toEqual(total(3));
  });

  it('finds the total at any depth', () => {
    expect(lastUsage([line({ a: { b: { c: { total_token_usage: total(7) } } } })])).toEqual(
      total(7),
    );
  });

  it('ignores blank lines and lines without it', () => {
    expect(lastUsage(['', line({ type: 'message', text: 'hi' }), ''])).toBeUndefined();
  });

  it('keeps the earlier total when a later line has the key without a value', () => {
    const lines = [
      line({ total_token_usage: total(5) }),
      line({ info: { total_token_usage: null } }),
    ];
    expect(lastUsage(lines)).toEqual(total(5));
  });

  it('does not match text that merely mentions the key in a message', () => {
    expect(lastUsage([line({ text: 'about total_token_usage' })])).toBeUndefined();
  });

  it('throws on a truncated line that mentions the key', () => {
    expect(() => lastUsage(['{"total_token_usage": {"input_tok'])).toThrow(SyntaxError);
  });

  it('is undefined with no lines', () => {
    expect(lastUsage([])).toBeUndefined();
  });
});
