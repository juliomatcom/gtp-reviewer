import { jest } from '@jest/globals';
import { describeError, isTransient, withRetry } from '../../src/lib/retry.js';
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

describe('describeError', () => {
  it('is just the message when there is no cause', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('adds the code and message of the cause behind a bare "fetch failed"', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(describeError(new Error('fetch failed', { cause }))).toBe(
      'fetch failed: ECONNRESET read ECONNRESET',
    );
  });

  it('lists every address that was tried and follows nested causes', () => {
    const attempt = (code) => Object.assign(new Error(`connect ${code}`), { code });
    const aggregate = Object.assign(new Error('all failed'), {
      errors: [attempt('ETIMEDOUT'), attempt('ENETUNREACH')],
      cause: new Error('socket closed'),
    });
    expect(describeError(new Error('fetch failed', { cause: aggregate }))).toBe(
      'fetch failed: all failed: ETIMEDOUT connect ETIMEDOUT: ENETUNREACH connect ENETUNREACH: socket closed',
    );
  });
});

describe('withRetry', () => {
  it('returns the result without sleeping when the call works', async () => {
    const sleep = makeSleep();
    expect(await withRetry(makeCore(), sleep, async () => 'ok')).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives each try its own live abort signal', async () => {
    const signals = [];
    const call = jest.fn(async (signal) => {
      signals.push(signal);
      if (signals.length === 1) throw httpError(500);
    });
    await withRetry(makeCore(), makeSleep(), call);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1].aborted).toBe(false);
  });

  it('always waits the full 20s, then 30s, after a failed attempt, and warns each time', async () => {
    const sleep = makeSleep();
    const core = makeCore();
    const call = jest
      .fn()
      .mockRejectedValueOnce(httpError(500, 'boom'))
      .mockRejectedValueOnce(httpError(502, 'bad gateway'))
      .mockResolvedValueOnce('done');
    expect(await withRetry(core, sleep, call)).toBe('done');
    expect(sleep.delays()).toEqual([20000, 30000]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/^GitHub did not answer after \d+ms \(boom\); retrying in 20s$/),
    );
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/^GitHub did not answer after \d+ms \(bad gateway\); retrying in 30s$/),
    );
  });

  it('gives the three attempts 20s, 30s and 60s to answer before each is aborted', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const call = jest.fn().mockRejectedValue(httpError(503, 'down'));
    await expect(withRetry(makeCore(), makeSleep(), call)).rejects.toThrow('down');
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([20000, 30000, 60000]);
    timeout.mockRestore();
  });

  it('gives up after the third attempt, with no wait after it, and throws the last error', async () => {
    const sleep = makeSleep();
    const call = jest.fn().mockRejectedValue(httpError(503, 'down'));
    await expect(withRetry(makeCore(), sleep, call)).rejects.toThrow('down');
    expect(call).toHaveBeenCalledTimes(3);
    expect(sleep.delays()).toEqual([20000, 30000]);
  });

  it('does not retry a final error', async () => {
    const sleep = makeSleep();
    const call = jest.fn().mockRejectedValue(httpError(422, 'invalid'));
    await expect(withRetry(makeCore(), sleep, call)).rejects.toThrow('invalid');
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('withRetry logging', () => {
  it('names the cause and how long the failed attempt took', async () => {
    const core = makeCore();
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const call = jest
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed', { cause }))
      .mockResolvedValueOnce('ok');
    await withRetry(core, makeSleep(), call);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringMatching(/after \d+ms \(fetch failed: ETIMEDOUT connect ETIMEDOUT\); retrying in 20s/),
    );
  });
});
