// Octokit reports a network failure ("fetch failed") and an aborted request as a 500, so a status of 500 or more covers both.
export const isTransient = (error) => (error.status ?? 500) >= 500;
export const RETRY_DELAYS_MS = [2000, 6000, 15000];
// A request that never answers would hang the job: every call is aborted after this long, and the
// whole post-review work gives up after the budget, so the step always ends.
export const REQUEST_TIMEOUT_MS = 30_000;
export const TOTAL_BUDGET_MS = 240_000;
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every GitHub call after a finished, paid review is retried: a GitHub blip must not throw the review away.
// `call` receives the octokit `request` option carrying the abort signal, and must pass it on.
export const createRetry = ({
  core,
  sleep = realSleep,
  now = Date.now,
  makeSignal = AbortSignal.timeout,
  budgetMs = TOTAL_BUDGET_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) => {
  const deadline = now() + budgetMs;
  return async (call) => {
    for (let retry = 0; ; retry++) {
      try {
        const signal = makeSignal(timeoutMs);
        // Raced, so a client that ignores the signal still cannot hold the step open.
        const timedOut = new Promise((_, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('GitHub request timed out'), { status: 500 })),
            { once: true },
          ),
        );
        timedOut.catch(() => {});
        return await Promise.race([call({ signal }), timedOut]);
      } catch (error) {
        const delay = RETRY_DELAYS_MS[retry];
        if (!isTransient(error) || delay === undefined || now() + delay >= deadline) throw error;
        core.warning(`GitHub did not answer (${error.message}); retrying in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  };
};
