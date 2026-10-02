const levels = { high: '🟢 High', medium: '🟡 Medium', low: '🔴 Low' };
const severities = { critical: 'Critical', major: 'Major', minor: 'Minor' };

export const comment = (finding) =>
  `**${finding.title}**\n\n${finding.body}\n\nSeverity: ${severities[finding.severity]}`;

export const summary = ({ findings, confidence, justification, unverified }, inline, usage) => {
  const lines = ['## Codex review', ''];
  if (findings.length === 0) lines.push('No findings.', '');
  else if (!inline) {
    lines.push(
      ...findings.map(
        (finding) =>
          `- \`${finding.path}:${finding.line}\` ${comment(finding).replace(/\n\n/g, ' — ')}`,
      ),
      '',
    );
  }
  lines.push('### Confidence', '', levels[confidence], '', justification);
  // Confidence ignores what no one could run, so the reader must see it here.
  if (unverified.length > 0) {
    lines.push('', '> [!WARNING]', '> **Not verified.** Check before or right after merging:', '>');
    lines.push(...unverified.map((item) => `> - ${item}`));
  }
  if (usage) lines.push('', `<sub>${usage}</sub>`);
  return lines.join('\n');
};
