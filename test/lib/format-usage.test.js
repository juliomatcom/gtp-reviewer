import { cost, formatUsage, tokens } from '../../src/lib/format-usage.js';

const usage = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
});

describe('tokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1.0k'],
    [1049, '1.0k'],
    [120_400, '120.4k'],
  ])('formats %s as %s', (count, text) => {
    expect(tokens(count)).toBe(text);
  });
});

describe('cost', () => {
  it('prices cached input at the cached rate and the rest at the input rate', () => {
    // 600k * $2 + 400k * $0.2 + 100k * $10 = 1.2 + 0.08 + 1.0 = $2.28 (gpt-6-sol)
    expect(cost('gpt-6-sol', usage(1_000_000, 400_000, 100_000))).toBe('≈ $2.28');
  });

  it('prices each known model', () => {
    expect(cost('gpt-6-astra', usage(1_000_000, 0, 1_000_000))).toBe('≈ $60.00');
    expect(cost('gpt-6-sol', usage(1_000_000, 0, 1_000_000))).toBe('≈ $12.00');
    expect(cost('gpt-6-luna', usage(1_000_000, 0, 1_000_000))).toBe('≈ $0.60');
  });

  it('uses four decimals below one cent and two from one cent', () => {
    expect(cost('gpt-6-luna', usage(2000, 0, 0))).toBe('≈ $0.0002');
    expect(cost('gpt-6-sol', usage(1_000_000, 0, 0))).toBe('≈ $2.00');
  });

  it('costs nothing for no usage', () => {
    expect(cost('gpt-6-luna', usage(0, 0, 0))).toBe('≈ $0.0000');
  });

  it('has no cost for a model without a price', () => {
    expect(cost('gpt-9-unknown', usage(1000, 0, 100))).toBeUndefined();
  });
});

describe('formatUsage', () => {
  it('summarizes model, effort, tokens and cost', () => {
    expect(formatUsage(usage(120_400, 98_100, 5_200), 'gpt-6-luna', 'medium')).toBe(
      'gpt-6-luna (medium) · 120.4k input, 98.1k cached · 5.2k output · ≈ $0.0058',
    );
  });

  it('leaves out the effort when not given, and the cost for an unknown model', () => {
    expect(formatUsage(usage(1000, 0, 100), 'gpt-9-unknown')).toBe(
      'gpt-9-unknown · 1.0k input, 0 cached · 100 output',
    );
  });
});
