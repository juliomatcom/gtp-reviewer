import { jest } from '@jest/globals';
import { isTransient, withRetry } from '../../src/lib/retry.js';
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

  it('retries with growing delays and warns each time', async () => {
    const sleep = makeSleep();
    const core = makeCore();
    const call = jest
      .fn()
      .mockRejectedValueOnce(httpError(500, 'boom'))
      .mockRejectedValueOnce(httpError(502, 'bad gateway'))
      .mockResolvedValueOnce('done');
    expect(await withRetry(core, sleep, call)).toBe('done');
    expect(sleep.delays()).toEqual([2000, 6000]);
    expect(core.warning).toHaveBeenCalledWith('GitHub did not answer (boom); retrying in 2s');
    expect(core.warning).toHaveBeenCalledWith(
      'GitHub did not answer (bad gateway); retrying in 6s',
    );
  });

  it('gives up after the third retry and throws the last error', async () => {
    const sleep = makeSleep();
    const call = jest.fn().mockRejectedValue(httpError(503, 'down'));
    await expect(withRetry(makeCore(), sleep, call)).rejects.toThrow('down');
    expect(call).toHaveBeenCalledTimes(4);
    expect(sleep.delays()).toEqual([2000, 6000, 15000]);
  });

  it('does not retry a final error', async () => {
    const sleep = makeSleep();
    const call = jest.fn().mockRejectedValue(httpError(422, 'invalid'));
    await expect(withRetry(makeCore(), sleep, call)).rejects.toThrow('invalid');
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
