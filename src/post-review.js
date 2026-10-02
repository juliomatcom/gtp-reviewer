import { comment, summary } from './lib/render-review.js';
import { realSleep, withRetry } from './lib/retry.js';
import usageLine from './lib/usage.js';

const BOT = 'github-actions[bot]';

// A stale approval would outlive a later push that lowered confidence.
const dismissApprovals = async (github, core, sleep, pull) => {
  const reviews = await withRetry(core, sleep, () => github.paginate(github.rest.pulls.listReviews, pull));
  for (const review of reviews) {
    if (review.user?.login !== BOT || review.state !== 'APPROVED') continue;
    await withRetry(core, sleep, () =>
      github.rest.pulls.dismissReview({
        ...pull,
        review_id: review.id,
        message: 'Codex confidence dropped below High.',
      }),
    );
  }
};

export default async function postReview(
  { github, context, core },
  { usageLine: readUsageLine = usageLine, sleep = realSleep } = {},
) {
  const result = JSON.parse(process.env.REVIEW);
  const pull = { ...context.repo, pull_number: context.payload.pull_request.number };
  const event = result.confidence === 'high' ? 'APPROVE' : 'COMMENT';
  let usage;
  try {
    usage = await readUsageLine({
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
      await withRetry(core, sleep, () =>
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
      await dismissApprovals(github, core, sleep, pull);
    } catch (error) {
      core.warning(`Could not dismiss earlier approvals: ${error.message}`);
    }
  }
}
