// Octokit reports a network failure ("fetch failed") and an aborted request as a 500.
export const isTransient = (error) => (error.status ?? 500) >= 500;

// Three attempts at posting, with fixed numbers: attempt 1 may take up to 20s to answer before it is aborted,
// attempt 2 up to 30s, attempt 3 up to 60s. After a failed attempt we always wait that same 20s, then 30s,
// however fast it failed, so a GitHub outage is not hammered and a slow recovery still gets caught.
export const ATTEMPT_WINDOWS_MS = [20_000, 30_000, 60_000];

// Every other request (listing and dismissing reviews) is aborted after this long, with no retry.
export const REQUEST_TIMEOUT_MS = 30_000;

// Octokit reports a network failure as a bare "fetch failed" and keeps the reason on `cause` (ECONNRESET, ETIMEDOUT,
// ENETUNREACH...), sometimes several of them (one per address tried). Say them all, or the log cannot tell a GitHub
// outage from a runner network problem.
export const describeError = (error) => {
  const parts = [error.message];
  const visit = (cause) => {
    if (!cause) return;
    parts.push([cause.code, cause.message].filter(Boolean).join(' '));
    (cause.errors ?? []).forEach(visit);
    visit(cause.cause);
  };
  visit(error.cause);
  return [...new Set(parts.filter(Boolean))].join(': ');
};

export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs `call(signal)` up to three times on a transient error. A finished, paid review must survive a GitHub blip.
export const withRetry = async (core, sleep, call) => {
  for (let attempt = 0; ; attempt++) {
    const window = ATTEMPT_WINDOWS_MS[attempt];
    const startedAt = Date.now();
    try {
      return await call(AbortSignal.timeout(window));
    } catch (error) {
      if (!isTransient(error) || attempt >= ATTEMPT_WINDOWS_MS.length - 1) throw error;
      core.warning(
        `GitHub did not answer after ${Date.now() - startedAt}ms (${describeError(error)}); retrying in ${window / 1000}s`,
      );
      await sleep(window);
    }
  }
};
