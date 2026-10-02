const find = (value, key) => {
  if (value === null || typeof value !== 'object') return undefined;
  if (key in value) return value[key];
  for (const child of Object.values(value)) {
    const found = find(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
};

// Codex logs a running token total in its session file; the last one is the run's usage.
export const lastUsage = (lines) => {
  let usage;
  for (const line of lines) {
    if (line.includes('"total_token_usage"')) usage = find(JSON.parse(line), 'total_token_usage') ?? usage;
  }
  return usage;
};
