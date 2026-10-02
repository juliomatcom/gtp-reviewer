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

/** A sleep that returns at once and records the delays it was asked for. */
export const makeSleep = () => {
  const sleep = jest.fn(async () => {});
  sleep.delays = () => sleep.mock.calls.map(([ms]) => ms);
  return sleep;
};
