// USD per 1M tokens, short context: https://developers.openai.com/api/docs/pricing
const PRICES = {
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
};

export const tokens = (count) => (count >= 1000 ? `${(count / 1000).toFixed(1)}k` : `${count}`);

// input_tokens includes the cached ones; output_tokens includes reasoning.
export const cost = (model, usage) => {
  const price = PRICES[model];
  if (!price) return undefined;
  const cached = usage.cached_input_tokens;
  const dollars =
    ((usage.input_tokens - cached) * price.input + cached * price.cached + usage.output_tokens * price.output) / 1e6;
  return `≈ $${dollars < 0.01 ? dollars.toFixed(4) : dollars.toFixed(2)}`;
};

// One line for the review summary, e.g. "gpt-6-luna (medium) · 120.4k input, 98.1k cached · 5.2k output · ≈ $0.0035".
export const formatUsage = (usage, model, effort) =>
  [
    effort ? `${model} (${effort})` : model,
    `${tokens(usage.input_tokens)} input, ${tokens(usage.cached_input_tokens)} cached`,
    `${tokens(usage.output_tokens)} output`,
    cost(model, usage),
  ]
    .filter(Boolean)
    .join(' · ');
