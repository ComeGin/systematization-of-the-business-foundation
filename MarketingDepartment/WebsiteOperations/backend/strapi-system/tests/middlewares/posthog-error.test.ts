import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errors } from '@strapi/utils';

vi.mock('../../src/posthog', () => ({
  capturePostHogException: vi.fn(async () => {}),
}));

import createMiddleware from '../../src/middlewares/posthog-error';
import { capturePostHogException } from '../../src/posthog';
import { httpError } from '../helpers/http-error';

const capture = vi.mocked(capturePostHogException);

const createFakeStrapi = () => ({ log: { debug: vi.fn() } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = () => createMiddleware({}, { strapi: createFakeStrapi() as any });

const ctx = (overrides: { user?: { id?: string | number }; method?: string; status?: number } = {}) => ({
  state: { user: overrides.user },
  method: overrides.method ?? 'GET',
  status: overrides.status ?? 404,
});

const failingNext = (error: unknown) => async () => {
  throw error;
};

beforeEach(() => {
  capture.mockReset();
  capture.mockResolvedValue(undefined);
});

describe('posthog-error: 初期化', () => {
  it('初期化時に debug ログを 1 回出す', () => {
    const strapi = createFakeStrapi();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMiddleware({}, { strapi: strapi as any });

    expect(strapi.log.debug).toHaveBeenCalledTimes(1);
  });
});

describe('posthog-error: 正常系', () => {
  it('next が成功したときは何も送らない', async () => {
    const next = vi.fn(async () => {});

    await build()(ctx(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('posthog-error: 想定内のクライアント応答は送らない', () => {
  it.each([
    ['ApplicationError', new errors.ApplicationError('bad')],
    ['ValidationError', new errors.ValidationError('invalid')],
    ['NotFoundError', new errors.NotFoundError('Preview config not found')],
    ['ForbiddenError', new errors.ForbiddenError()],
  ])('%s は送らずにそのまま再送出する', async (_name, error) => {
    await expect(build()(ctx(), failingNext(error))).rejects.toBe(error);
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([400, 401, 404, 499])('HttpError の %i は送らずにそのまま再送出する', async (status) => {
    const error = httpError(status);

    await expect(build()(ctx(), failingNext(error))).rejects.toBe(error);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('posthog-error: サーバー側の例外は送る', () => {
  it.each([500, 503])('HttpError の %i は送ってから再送出する', async (status) => {
    const error = httpError(status);

    await expect(build()(ctx({ status }), failingNext(error))).rejects.toBe(error);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(error, 'strapi_server', {
      request_method: 'GET',
      status_code: status,
    });
  });

  it('想定外の例外はリクエストのメソッドとステータスを付けて送り、同じ例外を再送出する', async () => {
    const error = new TypeError('unexpected');

    await expect(build()(ctx({ method: 'POST', status: 500 }), failingNext(error))).rejects.toBe(error);
    expect(capture).toHaveBeenCalledWith(error, 'strapi_server', {
      request_method: 'POST',
      status_code: 500,
    });
  });

  it('Error 以外の値が投げられても送ってから再送出する', async () => {
    const thrown = 'string thrown';

    await expect(build()(ctx(), failingNext(thrown))).rejects.toBe(thrown);
    expect(capture).toHaveBeenCalledWith(thrown, 'strapi_server', expect.any(Object));
  });

  it('ログイン中のユーザーがいれば distinctId を strapi-user-<id> にする', async () => {
    const error = new Error('boom');

    await expect(build()(ctx({ user: { id: 42 } }), failingNext(error))).rejects.toBe(error);
    expect(capture).toHaveBeenCalledWith(error, 'strapi-user-42', expect.any(Object));
  });

  it('ユーザーはいても id が無ければ strapi_server にする', async () => {
    const error = new Error('boom');

    await expect(build()(ctx({ user: {} }), failingNext(error))).rejects.toBe(error);
    expect(capture).toHaveBeenCalledWith(error, 'strapi_server', expect.any(Object));
  });

  it('送信が失敗しても、送信の例外ではなく元の例外を再送出する', async () => {
    const error = new Error('original');
    capture.mockRejectedValueOnce(new Error('posthog down'));

    await expect(build()(ctx(), failingNext(error))).rejects.toBe(error);
  });
});
