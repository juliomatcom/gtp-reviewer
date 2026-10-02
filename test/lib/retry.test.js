import { jest } from '@jest/globals';
import {
  createRetry,
  isTransient,
  RETRY_DELAYS_MS,
  REQUEST_TIMEOUT_MS,
  TOTAL_BUDGET_MS,
} from '../../src/lib/retry.js';
import { httpError, makeCore, makeSleep } from '../helpers.js';

describe('isTransient', () => {
  it.each([500, 502, 503, 599])('treats %s as transient', (status) => {
    expect(isTransient(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422, 429])('treats %s as final', (status) => {
    expect(isTransient(httpError(status))).toBe(false);
  });

  it('treats an error with no status (a network failure) as transient', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true);
  });
});

const setup = (options = {}) => {
  const core = makeCore();
  const sleep = makeSleep();
  const controllers = [];
  const makeSignal = jest.fn(() => {
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  const retry = createRetry({ core, sleep, makeSignal, now: () => 0, ...options });
  return { core, sleep, controllers, makeSignal, retry };
};

describe('createRetry', () => {
  it('returns the result without sleeping when the call works', async () => {
    const { retry, sleep } = setup();
    expect(await retry(async () => 'ok')).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives every call an abort signal with the request timeout', async () => {
    const { retry, makeSignal, controllers } = setup();
    const call = jest.fn(async () => 'ok');
    await retry(call);
    expect(makeSignal).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(call).toHaveBeenCalledWith({ signal: controllers[0].signal });
  });

  it('retries with the configured delays and warns each time', async () => {
    const { retry, sleep, core } = setup();
    const call = jest
      .fn()
      .mockRejectedValueOnce(httpError(500, 'boom'))
      .mockRejectedValueOnce(httpError(502, 'bad gateway'))
      .mockResolvedValueOnce('done');
    expect(await retry(call)).toBe('done');
    expect(sleep.delays()).toEqual([2000, 6000]);
    expect(core.warning).toHaveBeenCalledWith('GitHub did not answer (boom); retrying in 2s');
    expect(core.warning).toHaveBeenCalledWith(
      'GitHub did not answer (bad gateway); retrying in 6s',
    );
  });

  it('gives up after the last delay and throws the last error', async () => {
    const { retry, sleep } = setup();
    const call = jest.fn().mockRejectedValue(httpError(503, 'down'));
    await expect(retry(call)).rejects.toThrow('down');
    expect(call).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(sleep.delays()).toEqual([2000, 6000, 15000]);
  });

  it('does not retry a final error', async () => {
    const { retry, sleep } = setup();
    const call = jest.fn().mockRejectedValue(httpError(422, 'invalid'));
    await expect(retry(call)).rejects.toThrow('invalid');
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  describe('a request that never answers', () => {
    it('is cut off when its signal fires, even if the client ignores the signal', async () => {
      const { retry, controllers } = setup({ budgetMs: 1 });
      const hung = retry(() => new Promise(() => {}));
      controllers[0].abort();
      await expect(hung).rejects.toThrow('GitHub request timed out');
    });

    it('counts as transient: it is retried with a fresh signal', async () => {
      const { retry, controllers, sleep } = setup();
      const call = jest
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce('answered');
      const result = retry(call);
      await Promise.resolve();
      controllers[0].abort();
      expect(await result).toBe('answered');
      expect(controllers).toHaveLength(2);
      expect(sleep.delays()).toEqual([2000]);
    });

    it('does not raise an unhandled rejection when the call finishes before the timeout', async () => {
      const { retry, controllers } = setup();
      await retry(async () => 'fast');
      controllers[0].abort();
      await new Promise((resolve) => setImmediate(resolve));
    });
  });

  describe('the total budget', () => {
    it('stops retrying when the next wait would pass the deadline', async () => {
      let clock = 0;
      const { retry, sleep } = setup({ now: () => clock, budgetMs: 10_000 });
      const call = jest.fn(async () => {
        clock += 5000;
        throw httpError(500, 'down');
      });
      await expect(retry(call)).rejects.toThrow('down');
      // 1st failure at 5s: +2s wait fits. 2nd failure at 12s: +6s would pass 10s, so it stops.
      expect(call).toHaveBeenCalledTimes(2);
      expect(sleep.delays()).toEqual([2000]);
    });

    it('is shared by every call made through the same retry', async () => {
      let clock = 0;
      const { retry } = setup({ now: () => clock, budgetMs: 10_000 });
      await retry(async () => {
        clock = 9000;
      });
      const call = jest.fn().mockRejectedValue(httpError(500, 'down'));
      await expect(retry(call)).rejects.toThrow('down');
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('defaults keep the worst case to a few minutes', () => {
      expect(TOTAL_BUDGET_MS).toBeLessThanOrEqual(5 * 60_000);
      expect(REQUEST_TIMEOUT_MS).toBeLessThan(TOTAL_BUDGET_MS);
    });
  });
});
