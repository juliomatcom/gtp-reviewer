import { jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postReview from '../src/post-review.js';
import {
  REVIEW,
  finding,
  httpError,
  instantTimers,
  makeContext,
  makeCore,
  makeGithub,
} from './helpers.js';

const run = async ({ review = REVIEW, github = makeGithub(), core = makeCore(), context } = {}) => {
  process.env.REVIEW = JSON.stringify(review);
  await postReview({ github, core, context: context ?? makeContext() });
  return { github, core };
};

const created = (github) => github.rest.pulls.createReview.mock.calls.map(([params]) => params);

beforeEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.MODEL;
  delete process.env.EFFORT;
});
afterEach(() => jest.restoreAllMocks());

describe('what is posted', () => {
  it('approves on high confidence, inline, without touching earlier approvals', async () => {
    const { github } = await run({
      review: { ...REVIEW, confidence: 'high', findings: [finding()] },
    });
    const [call] = created(github);
    expect(call).toMatchObject({
      owner: 'o',
      repo: 'r',
      pull_number: 5,
      commit_id: 'headsha',
      event: 'APPROVE',
    });
    expect(github.paginate).not.toHaveBeenCalled();
    expect(github.rest.pulls.dismissReview).not.toHaveBeenCalled();
  });

  it.each([
    ['medium', 'COMMENT', '🟡 Medium'],
    ['low', 'COMMENT', '🔴 Low'],
    ['high', 'APPROVE', '🟢 High'],
  ])('maps %s confidence to %s and %s', async (confidence, event, label) => {
    const { github } = await run({ review: { ...REVIEW, confidence } });
    const [call] = created(github);
    expect(call.event).toBe(event);
    expect(call.body).toContain(label);
    expect(call.body).toContain('Looks fine.');
  });

  it('posts each finding as an inline comment on the right side with its severity', async () => {
    const { github } = await run({
      review: {
        ...REVIEW,
        findings: [
          finding({ severity: 'critical', path: 'a.js', line: 1, title: 'T1', body: 'B1' }),
          finding({ severity: 'minor', path: 'b.js', line: 2, title: 'T2', body: 'B2' }),
        ],
      },
    });
    const [call] = created(github);
    expect(call.comments).toEqual([
      { path: 'a.js', line: 1, side: 'RIGHT', body: '**T1**\n\nB1\n\nSeverity: Critical' },
      { path: 'b.js', line: 2, side: 'RIGHT', body: '**T2**\n\nB2\n\nSeverity: Minor' },
    ]);
    expect(call.body).not.toContain('T1');
  });

  it('says there are no findings', async () => {
    const { github } = await run();
    expect(created(github)[0].body).toContain('No findings.');
  });

  it('shows what could not be verified, prominently', async () => {
    const { github } = await run({
      review: { ...REVIEW, unverified: ['the migration on a real database', 'the Docker build'] },
    });
    const { body } = created(github)[0];
    expect(body).toContain('> [!WARNING]');
    expect(body).toContain('> - the migration on a real database');
    expect(body).toContain('> - the Docker build');
  });

  it('omits the warning when everything was verified', async () => {
    const { github } = await run();
    expect(created(github)[0].body).not.toContain('Not verified');
  });

  it('fails clearly on a review that is not JSON, posting nothing', async () => {
    process.env.REVIEW = 'not json';
    const github = makeGithub();
    await expect(postReview({ github, core: makeCore(), context: makeContext() })).rejects.toThrow(
      SyntaxError,
    );
    expect(github.rest.pulls.createReview).not.toHaveBeenCalled();
  });
});

describe('usage line', () => {
  const sessionHome = async (lines) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
    await mkdir(path.join(home, 'sessions'), { recursive: true });
    await writeFile(path.join(home, 'sessions', 'a.jsonl'), lines.join('\n'));
    return home;
  };

  it('adds the token usage when the session log has it', async () => {
    process.env.CODEX_HOME = await sessionHome([
      JSON.stringify({
        payload: {
          total_token_usage: { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 500 },
        },
      }),
    ]);
    process.env.MODEL = 'gpt-6-luna';
    process.env.EFFORT = 'medium';
    const { github } = await run();
    expect(created(github)[0].body).toContain('<sub>gpt-6-luna (medium) · 2.0k input');
  });

  it('still posts, with a warning, when the usage cannot be read', async () => {
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'does-not-exist-codex-home');
    const { github, core } = await run();
    expect(created(github)).toHaveLength(1);
    expect(created(github)[0].body).not.toContain('<sub>');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Codex usage unavailable'));
  });

  it('still posts when the session log has a truncated line', async () => {
    process.env.CODEX_HOME = await sessionHome(['{"total_token_usage": {"input_tok']);
    const { github, core } = await run();
    expect(created(github)).toHaveLength(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Codex usage unavailable'));
  });
});

describe('fallbacks when GitHub refuses the review', () => {
  it('drops the inline comments and lists the findings in the summary when a line is outside the diff', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValueOnce(httpError(422, 'line not in diff'));
    const { core } = await run({ github, review: { ...REVIEW, findings: [finding()] } });
    const [first, second] = created(github);
    expect(first.comments).toHaveLength(1);
    expect(second.comments).toBeUndefined();
    expect(second.body).toContain('`src/a.js:7`');
    expect(second.body).toContain('Bad thing');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Review attempt 1 failed'));
  });

  it('falls back to a plain comment when Actions may not approve', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview
      .mockRejectedValueOnce(httpError(422, 'cannot approve'))
      .mockRejectedValueOnce(httpError(422, 'cannot approve'));
    await run({ github, review: { ...REVIEW, confidence: 'high', findings: [finding()] } });
    expect(created(github).map((c) => c.event)).toEqual(['APPROVE', 'APPROVE', 'COMMENT']);
    expect(created(github)[2].comments).toHaveLength(1);
  });

  it('throws the last error once every attempt failed', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(403, 'forbidden'));
    await expect(run({ github })).rejects.toThrow('forbidden');
    expect(created(github)).toHaveLength(2);
  });

  it('does not retry a client error on the same attempt', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(404));
    await expect(run({ github, review: { ...REVIEW, confidence: 'high' } })).rejects.toThrow();
    expect(created(github)).toHaveLength(4);
  });
});

describe('retrying transient GitHub errors', () => {
  it('retries a 500 with growing delays and then succeeds', async () => {
    const delays = instantTimers();
    const github = makeGithub();
    github.rest.pulls.createReview
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({});
    const { core } = await run({ github });
    expect(delays).toEqual([2000, 6000]);
    expect(created(github)).toHaveLength(3);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('retrying in 2s'));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('retrying in 6s'));
  });

  it('treats a network failure without a status as transient', async () => {
    instantTimers();
    const github = makeGithub();
    github.rest.pulls.createReview
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({});
    await run({ github });
    expect(created(github)).toHaveLength(2);
  });

  it('gives up after three retries, then tries the next fallback', async () => {
    const delays = instantTimers();
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(503));
    await expect(run({ github })).rejects.toThrow('HTTP 503');
    expect(delays).toEqual([2000, 6000, 15000, 2000, 6000, 15000]);
    expect(created(github)).toHaveLength(8);
  });

  it('does not retry a 4xx', async () => {
    const delays = instantTimers();
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValueOnce(httpError(422)).mockResolvedValue({});
    await run({ github });
    expect(delays).toEqual([]);
  });
});

describe('stale approvals', () => {
  const review = (id, login, state) => ({ id, user: { login }, state });

  it('dismisses only approvals the bot made, after posting the review', async () => {
    const github = makeGithub({
      reviews: [
        review(1, 'github-actions[bot]', 'APPROVED'),
        review(2, 'github-actions[bot]', 'COMMENTED'),
        review(3, 'someone', 'APPROVED'),
        { id: 4, user: null, state: 'APPROVED' },
        review(5, 'github-actions[bot]', 'APPROVED'),
      ],
    });
    const order = [];
    github.rest.pulls.createReview.mockImplementation(async () => order.push('create'));
    github.rest.pulls.dismissReview.mockImplementation(async () => order.push('dismiss'));
    await run({ github });
    const dismissed = github.rest.pulls.dismissReview.mock.calls.map(([p]) => p.review_id);
    expect(dismissed).toEqual([1, 5]);
    expect(github.rest.pulls.dismissReview.mock.calls[0][0]).toMatchObject({
      pull_number: 5,
      message: 'Codex confidence dropped below High.',
    });
    expect(order).toEqual(['create', 'dismiss', 'dismiss']);
  });

  it('lists the reviews of this pull request through pagination', async () => {
    const github = makeGithub();
    await run({ github });
    expect(github.paginate).toHaveBeenCalledWith(github.rest.pulls.listReviews, {
      owner: 'o',
      repo: 'r',
      pull_number: 5,
    });
  });

  it('keeps an approval when confidence is still high', async () => {
    const github = makeGithub({ reviews: [review(1, 'github-actions[bot]', 'APPROVED')] });
    await run({ github, review: { ...REVIEW, confidence: 'high' } });
    expect(github.rest.pulls.dismissReview).not.toHaveBeenCalled();
  });

  it('still posts the review when listing reviews keeps failing (a transient 500)', async () => {
    const delays = instantTimers();
    const github = makeGithub();
    github.paginate.mockRejectedValue(httpError(500, 'fetch failed'));
    const { core } = await run({ github, review: { ...REVIEW, findings: [finding()] } });
    expect(created(github)).toHaveLength(1);
    expect(delays).toEqual([2000, 6000, 15000]);
    expect(core.warning).toHaveBeenCalledWith(
      'Could not dismiss earlier approvals: fetch failed',
    );
  });

  it('retries listing the reviews and then dismisses', async () => {
    instantTimers();
    const github = makeGithub({ reviews: [review(1, 'github-actions[bot]', 'APPROVED')] });
    github.paginate.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce([
      review(1, 'github-actions[bot]', 'APPROVED'),
    ]);
    await run({ github });
    expect(github.rest.pulls.dismissReview).toHaveBeenCalledTimes(1);
  });

  it('retries a failed dismissal', async () => {
    instantTimers();
    const github = makeGithub({ reviews: [review(1, 'github-actions[bot]', 'APPROVED')] });
    github.rest.pulls.dismissReview.mockRejectedValueOnce(httpError(502)).mockResolvedValue({});
    await run({ github });
    expect(github.rest.pulls.dismissReview).toHaveBeenCalledTimes(2);
  });

  it('warns, and does not throw, when a dismissal is refused', async () => {
    const github = makeGithub({ reviews: [review(1, 'github-actions[bot]', 'APPROVED')] });
    github.rest.pulls.dismissReview.mockRejectedValue(httpError(403, 'Resource not accessible'));
    const { core } = await run({ github });
    expect(created(github)).toHaveLength(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Could not dismiss earlier approvals: Resource not accessible',
    );
  });

  it('does not dismiss anything when the review could not be posted', async () => {
    const github = makeGithub({ reviews: [review(1, 'github-actions[bot]', 'APPROVED')] });
    github.rest.pulls.createReview.mockRejectedValue(httpError(403));
    await expect(run({ github })).rejects.toThrow();
    expect(github.rest.pulls.dismissReview).not.toHaveBeenCalled();
  });
});
