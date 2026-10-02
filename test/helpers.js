import { jest } from '@jest/globals';

export const REVIEW = {
  findings: [],
  confidence: 'medium',
  justification: 'Looks fine.',
  unverified: [],
};

export const finding = (over = {}) => ({
  path: 'src/a.js',
  line: 7,
  severity: 'major',
  title: 'Bad thing',
  body: 'It breaks.',
  ...over,
});

export const httpError = (status, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

export const makeCore = () => ({ warning: jest.fn(), info: jest.fn() });

export const makeContext = (over = {}) => ({
  repo: { owner: 'o', repo: 'r' },
  payload: { pull_request: { number: 5, head: { sha: 'headsha' }, ...over } },
});

/** A GitHub client whose calls are jest mocks; `reviews` is what listReviews returns. */
export const makeGithub = ({ reviews = [] } = {}) => {
  const github = {
    paginate: jest.fn(async () => reviews),
    rest: {
      pulls: {
        listReviews: Symbol('listReviews'),
        createReview: jest.fn(async () => ({})),
        dismissReview: jest.fn(async () => ({})),
      },
    },
  };
  return github;
};

/** Makes the retry backoff instant and records the delays it asked for. */
export const instantTimers = () => {
  const delays = [];
  jest.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
    delays.push(ms);
    fn();
    return 0;
  });
  return delays;
};
