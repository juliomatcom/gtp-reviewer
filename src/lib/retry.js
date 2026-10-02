// Octokit reports a network failure ("fetch failed") as a 500, so a status of 500 or more covers both.
export const isTransient = (error) => (error.status ?? 500) >= 500;
export const RETRY_DELAYS_MS = [2000, 6000, 15000];
export const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every GitHub call after a finished, paid review is retried: a GitHub blip must not throw the review away.
export const withRetry = async (core, sleep, call) => {
  for (let retry = 0; ; retry++) {
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error) || retry >= RETRY_DELAYS_MS.length) throw error;
      const seconds = RETRY_DELAYS_MS[retry] / 1000;
      core.warning(`GitHub did not answer (${error.message}); retrying in ${seconds}s`);
      await sleep(RETRY_DELAYS_MS[retry]);
    }
  }
};
