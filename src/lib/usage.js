import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { formatUsage } from './format-usage.js';
import { lastUsage } from './usage-log.js';

// Session files in name order, so the last running total is the latest one.
const readLines = async (codexHome, io) => {
  const dir = path.join(codexHome, 'sessions');
  const files = (await io.readdir(dir, { recursive: true })).filter((file) => file.endsWith('.jsonl'));
  const lines = [];
  for (const file of files.sort()) {
    lines.push(...(await io.readFile(path.join(dir, file), 'utf8')).split('\n'));
  }
  return lines;
};

export default async function usageLine({ codexHome, model, effort }, io = { readdir, readFile }) {
  const usage = lastUsage(await readLines(codexHome, io));
  return usage ? formatUsage(usage, model, effort) : undefined;
}
