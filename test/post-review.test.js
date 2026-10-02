import { jest } from '@jest/globals';
import postReview from '../src/post-review.js';
import {
  REVIEW,
  finding,
  httpError,
  makeSleep,
  makeContext,
  makeCore,
  makeGithub,
} from './helpers.js';

const run = async ({
  review = REVIEW,
  github = makeGithub(),
  core = makeCore(),
  sleep = makeSleep(),
  usageLine = async () => undefined,
} = {}) => {
  process.env.REVIEW = JSON.stringify(review);
  await postReview({ github, core, context: makeContext() }, { sleep, usageLine });
  return { github, core, sleep };
};

const created = (github) => github.rest.pulls.createReview.mock.calls.map(([params]) => params);

beforeEach(() => {
  process.env.CODEX_HOME = '/codex';
  process.env.MODEL = 'm';
  process.env.EFFORT = 'e';
});

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
          finding({
            severity: 'critical',
            path: 'a.js',
            line: 1,
            title: 'T1',
            body: 'B1',
          }),
          finding({
            severity: 'minor',
            path: 'b.js',
            line: 2,
            title: 'T2',
            body: 'B2',
          }),
        ],
      },
    });
    const [call] = created(github);
    expect(call.comments).toEqual([
      {
        path: 'a.js',
        line: 1,
        side: 'RIGHT',
        body: '**T1**\n\nB1\n\nSeverity: Critical',
      },
      {
        path: 'b.js',
        line: 2,
        side: 'RIGHT',
        body: '**T2**\n\nB2\n\nSeverity: Minor',
      },
    ]);
    expect(call.body).not.toContain('T1');
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
  it('asks for the usage of this run and appends it', async () => {
    const usageLine = jest.fn(async () => 'm (e) · 2.0k input');
    const { github } = await run({ usageLine });
    expect(usageLine).toHaveBeenCalledWith({
      codexHome: '/codex',
      model: 'm',
      effort: 'e',
    });
    expect(created(github)[0].body).toContain('<sub>m (e) · 2.0k input</sub>');
  });

  it('adds nothing when there is no usage', async () => {
    const { github } = await run();
    expect(created(github)[0].body).not.toContain('<sub>');
  });

  it('still posts, with a warning, when the usage cannot be read', async () => {
    const { github, core } = await run({
      usageLine: async () => {
        throw new Error('no sessions');
      },
    });
    expect(created(github)).toHaveLength(1);
    expect(core.warning).toHaveBeenCalledWith('Codex usage unavailable: no sessions');
  });
});

describe('fallbacks when GitHub refuses the review', () => {
  it('drops the inline comments and lists the findings in the summary when a line is outside the diff', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValueOnce(httpError(422, 'line not in diff'));
    const { core } = await run({
      github,
      review: { ...REVIEW, findings: [finding()] },
    });
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
    await run({
      github,
      review: { ...REVIEW, confidence: 'high', findings: [finding()] },
    });
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
    const github = makeGithub();
    github.rest.pulls.createReview
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({});
    const { core, sleep } = await run({ github });
    expect(sleep.delays()).toEqual([5000, 10000]);
    expect(created(github)).toHaveLength(3);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('retrying in 5s'));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('retrying in 10s'));
  });

  it('treats a network failure without a status as transient', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({});
    await run({ github });
    expect(created(github)).toHaveLength(2);
  });

  it('gives up after four retries and ends: it does not try the other variants', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(503));
    const sleep = makeSleep();
    await expect(run({ github, sleep })).rejects.toThrow('HTTP 503');
    expect(sleep.delays()).toEqual([5000, 10000, 20000, 25000]);
    expect(created(github)).toHaveLength(5);
  });

  it('never downgrades an approval to a comment because GitHub did not answer', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(500));
    await expect(run({ github, review: { ...REVIEW, confidence: 'high' } })).rejects.toThrow();
    expect(new Set(created(github).map((c) => c.event))).toEqual(new Set(['APPROVE']));
  });

  it('passes an abort signal on every request', async () => {
    const github = makeGithub({
      reviews: [{ id: 1, user: { login: 'github-actions[bot]' }, state: 'APPROVED' }],
    });
    await run({ github });
    expect(created(github)[0].request.signal).toBeInstanceOf(AbortSignal);
    expect(github.paginate.mock.calls[0][1].request.signal).toBeInstanceOf(AbortSignal);
    expect(github.rest.pulls.dismissReview.mock.calls[0][0].request.signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('does not retry a 4xx', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValueOnce(httpError(422)).mockResolvedValue({});
    const { sleep } = await run({ github });
    expect(sleep.delays()).toEqual([]);
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
    expect(github.paginate).toHaveBeenCalledWith(
      github.rest.pulls.listReviews,
      expect.objectContaining({ owner: 'o', repo: 'r', pull_number: 5 }),
    );
  });

  it('keeps an approval when confidence is still high', async () => {
    const github = makeGithub({
      reviews: [review(1, 'github-actions[bot]', 'APPROVED')],
    });
    await run({ github, review: { ...REVIEW, confidence: 'high' } });
    expect(github.rest.pulls.dismissReview).not.toHaveBeenCalled();
  });

  it('still posts the review when listing reviews fails (the 500 that lost a review)', async () => {
    const github = makeGithub();
    github.paginate.mockRejectedValue(httpError(500, 'fetch failed'));
    const { core, sleep } = await run({ github, review: { ...REVIEW, findings: [finding()] } });
    expect(created(github)).toHaveLength(1);
    expect(github.paginate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith('Could not dismiss earlier approvals: fetch failed');
  });

  it('does not retry a failed dismissal: it is best effort', async () => {
    const github = makeGithub({ reviews: [review(1, 'github-actions[bot]', 'APPROVED')] });
    github.rest.pulls.dismissReview.mockRejectedValue(httpError(502, 'bad gateway'));
    const { core, sleep } = await run({ github });
    expect(github.rest.pulls.dismissReview).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith('Could not dismiss earlier approvals: bad gateway');
  });

  it('warns, and does not throw, when a dismissal is refused', async () => {
    const github = makeGithub({
      reviews: [review(1, 'github-actions[bot]', 'APPROVED')],
    });
    github.rest.pulls.dismissReview.mockRejectedValue(httpError(403, 'Resource not accessible'));
    const { core } = await run({ github });
    expect(created(github)).toHaveLength(1);
    expect(core.warning).toHaveBeenCalledWith(
      'Could not dismiss earlier approvals: Resource not accessible',
    );
  });

  it('does not dismiss anything when the review could not be posted', async () => {
    const github = makeGithub({
      reviews: [review(1, 'github-actions[bot]', 'APPROVED')],
    });
    github.rest.pulls.createReview.mockRejectedValue(httpError(403));
    await expect(run({ github })).rejects.toThrow();
    expect(github.rest.pulls.dismissReview).not.toHaveBeenCalled();
  });
});

describe('a review that cannot be posted', () => {
  it('is kept in the job summary, and the step still fails', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(500, 'fetch failed'));
    const core = makeCore();
    await expect(
      run({ github, core, review: { ...REVIEW, findings: [finding({ title: 'Bad thing' })] } }),
    ).rejects.toThrow('fetch failed');
    const [text] = core.summary.addRaw.mock.calls[0];
    expect(text).toContain('Bad thing');
    expect(text).toContain('could not be posted');
    expect(core.summary.write).toHaveBeenCalledTimes(1);
  });

  it('is kept when every variant was rejected, too', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(403, 'forbidden'));
    const core = makeCore();
    await expect(run({ github, core })).rejects.toThrow('forbidden');
    expect(core.summary.write).toHaveBeenCalledTimes(1);
  });

  it('is not written when the review was posted', async () => {
    const core = makeCore();
    await run({ core });
    expect(core.summary.write).not.toHaveBeenCalled();
  });

  it('still fails with the original error when the summary cannot be written', async () => {
    const github = makeGithub();
    github.rest.pulls.createReview.mockRejectedValue(httpError(500, 'fetch failed'));
    const core = makeCore();
    core.summary.write.mockRejectedValue(new Error('disk full'));
    await expect(run({ github, core })).rejects.toThrow('fetch failed');
    expect(core.warning).toHaveBeenCalledWith(
      'Could not save the review to the job summary: disk full',
    );
  });
});
