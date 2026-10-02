import { jest } from '@jest/globals';
import buildPrompt from '../src/build-prompt.js';
import { makeCore } from './helpers.js';

const BUILT_IN = 'BUILT-IN REVIEW RULES';

const thread = (path, comments, isResolved = false) => ({
  path,
  isResolved,
  comments: { nodes: comments },
});
const comment = (login, body, authorAssociation = 'NONE') => ({
  author: { login },
  authorAssociation,
  body,
});

const pr = (over = {}) => ({
  number: 9,
  title: 'feat: a thing',
  body: 'Does a thing.',
  base: { ref: 'main', sha: 'basesha' },
  head: { sha: 'headsha' },
  ...over,
});

const run = async ({ threads = [], instructions, pull = pr(), graphqlError } = {}) => {
  process.env.PROMPT_FILE = '/out/prompt.md';
  if (instructions) process.env.INSTRUCTIONS_FILE = instructions;
  else delete process.env.INSTRUCTIONS_FILE;
  const io = {
    readFile: jest.fn(async () => BUILT_IN),
    writeFile: jest.fn(async () => {}),
    gitShow: jest.fn(() => 'BASE RULES'),
  };
  const github = {
    graphql: jest.fn(async () => {
      if (graphqlError) throw graphqlError;
      return {
        repository: { pullRequest: { reviewThreads: { nodes: threads } } },
      };
    }),
  };
  const core = makeCore();
  await buildPrompt(
    {
      github,
      core,
      context: {
        repo: { owner: 'o', repo: 'r' },
        payload: { pull_request: pull },
      },
    },
    io,
  );
  return { text: io.writeFile.mock.calls[0]?.[1], io, github, core };
};

describe('buildPrompt', () => {
  it('starts with the built-in review instructions and describes the pull request', async () => {
    const { text, io } = await run();
    expect(text.startsWith(BUILT_IN)).toBe(true);
    expect(text).toContain('## Pull request #9');
    expect(text).toContain('Diff: `git diff basesha...headsha`');
    expect(text).toContain('Title: feat: a thing');
    expect(text).toContain('Body:\n\nDoes a thing.');
    expect(text.endsWith('\n')).toBe(true);
    expect(io.writeFile.mock.calls[0][0]).toBe('/out/prompt.md');
  });

  it('copes with a pull request that has no body', async () => {
    const { text } = await run({ pull: pr({ body: null }) });
    expect(text).toContain('Body:\n\n## Earlier review threads');
    expect(text).not.toContain('null');
  });

  it('reads the project instructions from the base branch, never from the pull request checkout', async () => {
    const { text, io } = await run({ instructions: '.github/review.md' });
    expect(io.gitShow).toHaveBeenCalledWith('origin/main', '.github/review.md');
    expect(text).toContain('## Project instructions\n\nBASE RULES');
    // Only the built-in review.md is read from disk; the checkout's copy is never opened.
    expect(io.readFile).toHaveBeenCalledTimes(1);
  });

  it('uses the base branch of the pull request', async () => {
    const { io } = await run({
      instructions: 'x.md',
      pull: pr({ base: { ref: 'release', sha: 's' } }),
    });
    expect(io.gitShow).toHaveBeenCalledWith('origin/release', 'x.md');
  });

  it('adds no project section when none is configured', async () => {
    const { text, io } = await run();
    expect(text).not.toContain('## Project instructions');
    expect(io.gitShow).not.toHaveBeenCalled();
  });

  it('fails when the instructions file is missing on the base branch', async () => {
    process.env.PROMPT_FILE = '/out/prompt.md';
    process.env.INSTRUCTIONS_FILE = 'missing.md';
    const io = {
      readFile: async () => BUILT_IN,
      writeFile: jest.fn(),
      gitShow: () => {
        throw new Error('fatal: path does not exist');
      },
    };
    const github = {
      graphql: async () => ({
        repository: { pullRequest: { reviewThreads: { nodes: [] } } },
      }),
    };
    await expect(
      buildPrompt(
        {
          github,
          core: makeCore(),
          context: {
            repo: { owner: 'o', repo: 'r' },
            payload: { pull_request: pr() },
          },
        },
        io,
      ),
    ).rejects.toThrow('does not exist');
    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it('says "None." when there are no earlier threads', async () => {
    const { text } = await run();
    expect(text).toContain('## Earlier review threads\n\nNone.');
  });

  it('shows the bot threads with their state, so declined findings are not raised again', async () => {
    const { text } = await run({
      threads: [
        thread('a.js', [comment('github-actions', 'Missing check')], true),
        thread('b.js', [comment('github-actions', 'Race')], false),
      ],
    });
    expect(text).toContain('### `a.js` (resolved)');
    expect(text).toContain('### `b.js` (open)');
    expect(text).toContain('- **github-actions**: Missing check');
  });

  it('asks for this pull request’s threads', async () => {
    const { github } = await run();
    expect(github.graphql.mock.calls[0][1]).toEqual({
      owner: 'o',
      name: 'r',
      number: 9,
    });
  });

  it('warns and goes on when the thread lookup fails', async () => {
    const { text, core } = await run({
      graphqlError: new Error('rate limited'),
    });
    expect(text).toContain('## Earlier review threads\n\nUnavailable.');
    expect(core.warning).toHaveBeenCalledWith('Earlier review threads unavailable: rate limited');
  });
});
