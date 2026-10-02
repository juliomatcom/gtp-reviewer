// Octokit reports a network failure ("fetch failed") and an aborted request as a 500.
export const isTransient = (error) => (error.status ?? 500) >= 500;

const DELAYS_MS = [2000, 6000, 15000];
// Every request is aborted after this long, so one that never answers fails (and is retried)
// instead of holding the step open.
export const REQUEST_TIMEOUT_MS = 30_000;

export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries `call(signal)` on a transient error. A finished, paid review must survive a GitHub blip.
export const withRetry = async (core, sleep, call) => {
  for (let retry = 0; ; retry++) {
    try {
      return await call(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (error) {
      if (!isTransient(error) || retry >= DELAYS_MS.length) throw error;
      core.warning(`GitHub did not answer (${error.message}); retrying in ${DELAYS_MS[retry] / 1000}s`);
      await sleep(DELAYS_MS[retry]);
    }
  }
};
