const BOT = 'github-actions';
// Anyone can comment on a public PR; replies count only from people with write access.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Earlier review threads as prompt text, so a finding the author already resolved or
// declined is not raised again. Only threads the bot started are shown.
export const formatThreads = (nodes) =>
  nodes
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
