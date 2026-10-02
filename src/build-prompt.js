import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { isResolved path
      comments(first: 20) { nodes { author { login } authorAssociation body } } } } } } }`;

const BOT = 'github-actions';
// Anyone can comment on a public PR; replies count only from people with write access.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Earlier review threads on this PR, so a finding the author already resolved or
// declined is not raised again.
const threads = async (github, context) => {
  const { repository } = await github.graphql(THREADS, {
    owner: context.repo.owner,
    name: context.repo.repo,
    number: context.payload.pull_request.number,
  });
  return repository.pullRequest.reviewThreads.nodes
    .filter((thread) => thread.comments.nodes[0]?.author?.login === BOT)
    .map((thread) => {
      const replies = thread.comments.nodes
        .filter(
          (reply) =>
            reply.author?.login === BOT || (reply.author && TRUSTED.has(reply.authorAssociation)),
        )
        .map((reply) => `- **${reply.author?.login}**: ${reply.body.replace(/\n+/g, ' ')}`);
      const state = thread.isResolved ? 'resolved' : 'open';
      return [`### \`${thread.path}\` (${state})`, '', ...replies].join('\n');
    })
    .join('\n\n');
};

// Read from the base branch: the PR checkout could rewrite its own instructions.
const instructions = (pr, path) =>
  execFileSync('git', ['show', `origin/${pr.base.ref}:${path}`], {
    cwd: process.env.GITHUB_WORKSPACE,
    encoding: 'utf8',
  });

export default async function buildPrompt({ github, context, core }) {
  const pr = context.payload.pull_request;
  const parts = [await readFile(new URL('review.md', import.meta.url), 'utf8')];
  if (process.env.INSTRUCTIONS_FILE) {
    parts.push(`## Project instructions\n\n${instructions(pr, process.env.INSTRUCTIONS_FILE)}`);
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
  await writeFile(process.env.PROMPT_FILE, `${parts.map((part) => part.trim()).join('\n\n')}\n`);
}
