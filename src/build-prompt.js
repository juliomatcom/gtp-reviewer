import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { formatThreads } from './lib/threads.js';

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { isResolved path
      comments(first: 20) { nodes { author { login } authorAssociation body } } } } } } }`;

const threads = async (github, context) => {
  const { repository } = await github.graphql(THREADS, {
    owner: context.repo.owner,
    name: context.repo.repo,
    number: context.payload.pull_request.number,
  });
  return formatThreads(repository.pullRequest.reviewThreads.nodes);
};

// `git show` of a file on the base branch, which the PR checkout cannot rewrite.
const gitShow = (ref, path) =>
  execFileSync('git', ['show', `${ref}:${path}`], {
    cwd: process.env.GITHUB_WORKSPACE,
    encoding: 'utf8',
  });

export default async function buildPrompt(
  { github, context, core },
  io = { readFile, writeFile, gitShow },
) {
  const pr = context.payload.pull_request;
  const parts = [await io.readFile(new URL('review.md', import.meta.url), 'utf8')];
  if (process.env.INSTRUCTIONS_FILE) {
    parts.push(
      `## Project instructions\n\n${io.gitShow(`origin/${pr.base.ref}`, process.env.INSTRUCTIONS_FILE)}`,
    );
  }

  let earlier;
  try {
    earlier = (await threads(github, context)) || 'None.';
  } catch (error) {
    // A failed lookup must not block the review; it only loses the memory.
    core.warning(`Earlier review threads unavailable: ${error.message}`);
    earlier = 'Unavailable.';
  }

  parts.push(
    `## Pull request #${pr.number}`,
    `Diff: \`git diff ${pr.base.sha}...${pr.head.sha}\``,
    `Title: ${pr.title}`,
    `Body:\n\n${pr.body ?? ''}`,
    `## Earlier review threads\n\n${earlier}`,
  );
  await io.writeFile(process.env.PROMPT_FILE, `${parts.map((part) => part.trim()).join('\n\n')}\n`);
}
