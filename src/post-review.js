import { comment, summary } from './lib/render-review.js';
import { createRetry, isTransient } from './lib/retry.js';
import usageLine from './lib/usage.js';

const BOT = 'github-actions[bot]';

// A stale approval would outlive a later push that lowered confidence.
const dismissApprovals = async (github, retry, pull) => {
  const reviews = await retry((request) =>
    github.paginate(github.rest.pulls.listReviews, { ...pull, request }),
  );
  for (const review of reviews) {
    if (review.user?.login !== BOT || review.state !== 'APPROVED') continue;
    await retry((request) =>
      github.rest.pulls.dismissReview({
        ...pull,
        review_id: review.id,
        message: 'Codex confidence dropped below High.',
        request,
      }),
    );
  }
};

// The review is paid for: when it cannot be posted, keep it where no network is needed.
const saveToJobSummary = async (core, text) => {
  try {
    await core.summary.addRaw(`${text}\n\n_This review could not be posted to the pull request._`, true).write();
  } catch (error) {
    core.warning(`Could not save the review to the job summary: ${error.message}`);
  }
};

export default async function postReview(
  { github, context, core },
  { usageLine: readUsageLine = usageLine, ...retryOptions } = {},
) {
  const result = JSON.parse(process.env.REVIEW);
  const pull = { ...context.repo, pull_number: context.payload.pull_request.number };
  const event = result.confidence === 'high' ? 'APPROVE' : 'COMMENT';
  const retry = createRetry({ core, ...retryOptions });
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
      await retry((request) =>
        github.rest.pulls.createReview({
          ...pull,
          commit_id: context.payload.pull_request.head.sha,
          ...attempt,
          request,
        }),
      );
      break;
    } catch (error) {
      // GitHub not answering is not a rejection of this variant: trying the others only wastes time
      // and could downgrade an approval to a comment. Keep the review and end the step.
      if (isTransient(error) || index === attempts.length - 1) {
        await saveToJobSummary(core, summary(result, false, usage));
        throw error;
      }
      core.warning(`Review attempt ${index + 1} failed: ${error.message}`);
    }
  }

  // After the review is posted, and never fatal: a stale approval is a smaller loss than the findings.
  if (event === 'COMMENT') {
    try {
      await dismissApprovals(github, retry, pull);
    } catch (error) {
      core.warning(`Could not dismiss earlier approvals: ${error.message}`);
    }
  }
}
