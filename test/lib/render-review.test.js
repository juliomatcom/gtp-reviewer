import { comment, summary } from '../../src/lib/render-review.js';
import { REVIEW, finding } from '../helpers.js';

describe('comment', () => {
  it.each([
    ['critical', 'Critical'],
    ['major', 'Major'],
    ['minor', 'Minor'],
  ])('labels a %s finding', (severity, label) => {
    expect(comment(finding({ severity, title: 'T', body: 'B' }))).toBe(
      `**T**\n\nB\n\nSeverity: ${label}`,
    );
  });
});

describe('summary', () => {
  it.each([
    ['high', '🟢 High'],
    ['medium', '🟡 Medium'],
    ['low', '🔴 Low'],
  ])('shows %s confidence as %s with the justification', (confidence, label) => {
    const text = summary({ ...REVIEW, confidence, justification: 'Because.' }, true);
    expect(text).toContain(`### Confidence\n\n${label}\n\nBecause.`);
  });

  it('says there are no findings', () => {
    expect(summary(REVIEW, true)).toContain('No findings.');
  });

  it('leaves findings out when they are posted inline', () => {
    const text = summary({ ...REVIEW, findings: [finding({ title: 'Bad thing' })] }, true);
    expect(text).not.toContain('Bad thing');
    expect(text).not.toContain('No findings.');
  });

  it('lists findings with their location when they cannot be inline', () => {
    const text = summary(
      { ...REVIEW, findings: [finding({ path: 'a.js', line: 3, title: 'T', body: 'B' })] },
      false,
    );
    expect(text).toContain('- `a.js:3` **T** — B — Severity: Major');
  });

  it('warns about what was not verified, one bullet each', () => {
    const text = summary({ ...REVIEW, unverified: ['the migration', 'the build'] }, true);
    expect(text).toContain('> [!WARNING]');
    expect(text).toContain('> - the migration\n> - the build');
  });

  it('has no warning when everything was verified', () => {
    expect(summary(REVIEW, true)).not.toContain('Not verified');
  });

  it('appends the usage line only when there is one', () => {
    expect(summary(REVIEW, true, 'm · 1k input')).toContain('<sub>m · 1k input</sub>');
    expect(summary(REVIEW, true)).not.toContain('<sub>');
  });
});
