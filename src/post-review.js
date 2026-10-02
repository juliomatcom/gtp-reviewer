import usageLine from './usage.js';

const levels = { high: '🟢 High', medium: '🟡 Medium', low: '🔴 Low' };
const severities = { critical: 'Critical', major: 'Major', minor: 'Minor' };

const comment = (finding) =>
  `**${finding.title}**\n\n${finding.body}\n\nSeverity: ${severities[finding.severity]}`;

const summary = ({ findings, confidence, justification, unverified }, inline, usage) => {
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

const BOT = 'github-actions[bot]';

// Octokit reports a network failure ("fetch failed") as a 500, so a status of 500 or more covers both.
const isTransient = (error) => (error.status ?? 500) >= 500;
const RETRY_DELAYS_MS = [2000, 6000, 15000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every GitHub call after a finished, paid review is retried: a GitHub blip must not throw the review away.
const withRetry = async (core, call) => {
  for (let retry = 0; ; retry++) {
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error) || retry >= RETRY_DELAYS_MS.length) throw error;
      const seconds = RETRY_DELAYS_MS[retry] / 1000;
      core.warning(`GitHub did not answer (${error.message}); retrying in ${seconds}s`);
      await sleep(RETRY_DELAYS_MS[retry]);
    }
  }
};

// A stale approval would outlive a later push that lowered confidence.
const dismissApprovals = async (github, core, pull) => {
  const reviews = await withRetry(core, () => github.paginate(github.rest.pulls.listReviews, pull));
  for (const review of reviews) {
    if (review.user?.login !== BOT || review.state !== 'APPROVED') continue;
    await withRetry(core, () =>
      github.rest.pulls.dismissReview({
        ...pull,
        review_id: review.id,
        message: 'Codex confidence dropped below High.',
      }),
    );
  }
};

export default async function postReview({ github, context, core }) {
  const result = JSON.parse(process.env.REVIEW);
  const pull = { ...context.repo, pull_number: context.payload.pull_request.number };
  const event = result.confidence === 'high' ? 'APPROVE' : 'COMMENT';
  let usage;
  try {
    usage = await usageLine({
      codexHome: process.env.CODEX_HOME,
      model: process.env.MODEL,
      effort: process.env.EFFORT,
    });
  } catch (error) {
    // Usage is a courtesy; a missing session log must not block the review.
    core.warning(`Codex usage unavailable: ${error.message}`);
  }

  const inline = result.findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: 'RIGHT',
    body: comment(finding),
  }));
  // A line outside the diff rejects inline comments; a repo that bars Actions from approving rejects APPROVE.
  const events = event === 'APPROVE' ? ['APPROVE', 'COMMENT'] : ['COMMENT'];
  const attempts = events.flatMap((each) => [
    { event: each, body: summary(result, true, usage), comments: inline },
    { event: each, body: summary(result, false, usage) },
  ]);

  for (const [index, attempt] of attempts.entries()) {
    try {
      await withRetry(core, () =>
        github.rest.pulls.createReview({
          ...pull,
          commit_id: context.payload.pull_request.head.sha,
          ...attempt,
        }),
      );
      break;
    } catch (error) {
      if (index === attempts.length - 1) throw error;
      core.warning(`Review attempt ${index + 1} failed: ${error.message}`);
    }
  }

  // After the review is posted, and never fatal: a stale approval is a smaller loss than the findings.
  if (event === 'COMMENT') {
    try {
      await dismissApprovals(github, core, pull);
    } catch (error) {
      core.warning(`Could not dismiss earlier approvals: ${error.message}`);
    }
  }
}
