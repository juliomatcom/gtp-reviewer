# gtp-reviewer

[![CI](https://github.com/juliomatcom/gtp-reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/juliomatcom/gtp-reviewer/actions/workflows/ci.yml) [![Release](https://github.com/juliomatcom/gtp-reviewer/actions/workflows/release.yml/badge.svg)](https://github.com/juliomatcom/gtp-reviewer/actions/workflows/release.yml)

A composite action that reviews a pull request with Codex and posts the result:

- Inline findings, each ending with its severity (Critical, Major or Minor).
- A summary with a 🟢/🟡/🔴 merge confidence. Confidence follows the findings: 🟢 means no open finding above Minor.
- A warning in the summary listing what neither the tests nor Codex could verify, such as a workflow that only runs after merge. It never lowers confidence.
- A footer with the run's token usage and estimated cost, read from the Codex session log and priced from a short-context table in [`format-usage.js`](src/lib/format-usage.js). Models missing from the table show tokens only.
- An approval on 🟢. The action dismisses its own earlier approval when a later push rates lower.

Each run feeds the PR's earlier review threads into the prompt. It only counts replies from people with write access, and it tells Codex not to raise a finding again once it is resolved or answered.

The review is also exposed as the `review` output: JSON matching [`review-schema.json`](src/review-schema.json).

## Inputs

| Input                | Default               | Notes                                                                                                           |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `openai-api-key`     | required              |                                                                                                                 |
| `model`              | `gpt-6-luna`          |                                                                                                                 |
| `effort`             | `medium`              |                                                                                                                 |
| `permission-profile` | `:workspace`          | Codex sandbox profile.                                                                                          |
| `instructions-file`  | none                  | Repo-relative project instructions, read from the **base branch** and appended to [`review.md`](src/review.md). |
| `github-token`       | `${{ github.token }}` | Fetches the base and head refs, reads earlier review threads and posts the review; needs `pull-requests: write`. |

## Usage

```yaml
name: Codex review

on:
  # Runs the workflow from the base branch, so a PR cannot rewrite its own review.
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
    branches: [main]

concurrency:
  group: codex-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # pull_request_target hands secrets to forks; never review them.
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    # A composite action cannot set its own timeout; this is what ends a job whose runner stops reporting.
    timeout-minutes: 15
    steps:
      - uses: juliomatcom/gtp-reviewer@v1
        with:
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          instructions-file: .github/codex/review.md
```

The repo needs an `OPENAI_API_KEY` secret. On the GitHub Free plan, organization secrets do not reach private repos, so add it as a repository secret there. To let the bot approve, the repo also needs the setting _Allow GitHub Actions to create and approve pull requests_. Without that setting, the review is posted as a comment instead.

### When GitHub does not answer

Every GitHub call after the review is written is aborted after 30 seconds, so a request that never answers fails instead of hanging. Posting the review is tried up to 3 times: the attempts are given 20s, 30s and 60s to answer before each is aborted, and after a failed attempt it always waits 20s, then 30s, before the next, however fast the failure was. Then the step fails; it never tries the other review variants (without inline comments, comment instead of approval) because GitHub is down, only when GitHub rejects one. If the review cannot be posted, it is written to the job summary (open the run's Summary tab: the step is red but the review is not lost). Dismissing an earlier approval is one best-effort try. Keep `timeout-minutes` on the job as above: it is the only thing that ends a job whose runner itself stops reporting.

## Example output

A PR with one minor finding gets 🟢 High, so the action approves it. It posts the finding as an inline comment on `path/to/file.ts:42`:

```markdown
**Short title of the defect.**

The concrete failure scenario and the fix, in plain words.

Severity: Minor
```

And this summary as the review body:

```markdown
## Codex review

### Confidence

🟢 High

One or two sentences grounded in the findings and test coverage.

> [!WARNING]
> **Not verified.** Check before or right after merging:
>
> - Behavior the tests could not reach, and what to check.

<sub>gpt-6-luna (medium) · 100.0k input, 80.0k cached · 5.0k output · ≈ $0.0053</sub>
```

With no findings, the summary says `No findings.` above the confidence. When an inline comment is rejected, for example because its line is outside the diff, each finding is listed in the summary instead: `` - `path/to/file.ts:42` **Short title of the defect.** — … — Severity: Minor ``.

## License

MIT. Copyright (c) 2026 Julio Cesar Martin.
