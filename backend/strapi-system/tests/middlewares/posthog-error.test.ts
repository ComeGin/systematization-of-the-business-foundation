import { beforeEach, describe, expect, it, vi } from 'vitest';
// @strapi/utils は偽物にしない。このミドルウェアの本質は「Strapi の本物の例外クラスを instanceof で見分けること」で、
// errors は I/O を持たない値のクラスだけのため（送信先の src/posthog は偽物にする）
import { errors } from '@strapi/utils';

vi.mock('../../src/posthog', () => ({
  capturePostHogException: vi.fn(async () => {}),
}));

import createMiddleware from '../../src/middlewares/posthog-error';
import { capturePostHogException } from '../../src/posthog';
import { httpError, koaHttpError } from '../helpers/http-error';

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

describe('posthog-error', () => {
  describe('正常系', () => {
    it('初期化時に debug ログを 1 回出す', () => {
      const strapi = createFakeStrapi();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createMiddleware({}, { strapi: strapi as any });

      expect(strapi.log.debug).toHaveBeenCalledTimes(1);
    });

    it('空入力: 設定が undefined でも初期化できる', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(typeof createMiddleware(undefined, { strapi: createFakeStrapi() as any })).toBe('function');
    });

    it('next が成功したときは何も送らない', async () => {
      const next = vi.fn(async () => {});

      await build()(ctx(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(capture).not.toHaveBeenCalled();
    });

    it('空入力: ctx.state にユーザーが無くても next の成功はそのまま通す', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(build()({ state: {}, method: 'GET', status: 200 } as any, async () => 'ok')).resolves.toBeUndefined();
      expect(capture).not.toHaveBeenCalled();
    });
  });

  describe('異常系', () => {
    it.each([
      ['ApplicationError', new errors.ApplicationError('bad')],
      ['ValidationError', new errors.ValidationError('invalid')],
      ['NotFoundError', new errors.NotFoundError('Preview config not found')],
      ['ForbiddenError', new errors.ForbiddenError()],
    ])('入力: %s は想定内のクライアント応答として送らずにそのまま再送出する', async (_name, error) => {
      await expect(build()(ctx(), failingNext(error))).rejects.toBe(error);
      expect(capture).not.toHaveBeenCalled();
    });

    it.each([400, 401, 403, 404, 409, 422, 429, 499])(
      '入力: HttpError の %i は想定内のクライアント応答として送らずにそのまま再送出する',
      async (status) => {
        const error = httpError(status);

        await expect(build()(ctx(), failingNext(error))).rejects.toBe(error);
        expect(capture).not.toHaveBeenCalled();
      }
    );

    it.each([400, 404, 409])(
      '入力: koa の ctx.throw（別の版の http-errors）の %i も、instanceof に頼らず想定内として送らない',
      async (status) => {
        const error = koaHttpError(status, 'msg');
        // 前提: クラスが別なので errors.HttpError の instanceof は偽（回帰の再現条件）
        expect(error instanceof errors.HttpError).toBe(false);

        await expect(build()(ctx({ status }), failingNext(error))).rejects.toBe(error);
        expect(capture).not.toHaveBeenCalled();
      }
    );

    it('サーバ: koa の ctx.throw の 5xx（expose が false）は送ってから再送出する', async () => {
      const error = koaHttpError(503);

      await expect(build()(ctx({ status: 503 }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('サーバ: status が 4xx でも expose の無い例外（上流の HTTP の失敗を写したもの）は送る', async () => {
      const error = Object.assign(new Error('Request failed with status code 404'), { status: 404 });

      await expect(build()(ctx({ status: 500 }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('空入力: status が数値でない（文字列の "404"）例外は想定内として扱わず送る', async () => {
      const error = Object.assign(new Error('odd'), { status: '404', expose: true });

      await expect(build()(ctx(), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it.each([500, 502, 503, 504])('サーバ: HttpError の %i は送ってから再送出する', async (status) => {
      const error = httpError(status);

      await expect(build()(ctx({ status }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith(error, 'strapi_server', {
        request_method: 'GET',
        status_code: status,
      });
    });

    it('サーバ: 想定外の例外はリクエストのメソッドとステータスを付けて送り、同じ例外を再送出する', async () => {
      const error = new TypeError('unexpected');

      await expect(build()(ctx({ method: 'POST', status: 500 }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledWith(error, 'strapi_server', {
        request_method: 'POST',
        status_code: 500,
      });
    });

    it('サーバ: RDS（pg）への接続失敗の例外も送ってから再送出する', async () => {
      const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.10:5432'), { code: 'ECONNREFUSED' });

      await expect(build()(ctx({ status: 500 }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledWith(error, 'strapi_server', expect.any(Object));
    });

    it('サーバ: S3 のアップロードの失敗（AWS SDK の例外）も送ってから再送出する', async () => {
      const error = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });

      await expect(build()(ctx({ method: 'POST', status: 500 }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('サーバ: Error 以外の値が投げられても送ってから再送出する', async () => {
      const thrown = 'string thrown';

      await expect(build()(ctx(), failingNext(thrown))).rejects.toBe(thrown);
      expect(capture).toHaveBeenCalledWith(thrown, 'strapi_server', expect.any(Object));
    });

    it('空入力: undefined が投げられても送ってから undefined を再送出する', async () => {
      await expect(build()(ctx(), failingNext(undefined))).rejects.toBeUndefined();
      expect(capture).toHaveBeenCalledWith(undefined, 'strapi_server', expect.any(Object));
    });

    it('サーバ: ログイン中のユーザーがいれば distinctId を strapi-user-<id> にする', async () => {
      const error = new Error('boom');

      await expect(build()(ctx({ user: { id: 42 } }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledWith(error, 'strapi-user-42', expect.any(Object));
    });

    it('空入力: ユーザーはいても id が無ければ strapi_server にする', async () => {
      const error = new Error('boom');

      await expect(build()(ctx({ user: {} }), failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledWith(error, 'strapi_server', expect.any(Object));
    });

    it('入力: リクエストのヘッダー（Authorization）や本文は送らず、メソッドとステータスだけを送る', async () => {
      const error = new Error('boom');
      const request = {
        ...ctx({ method: 'PUT', status: 500 }),
        request: { header: { authorization: 'Bearer secret-api-token' }, body: { password: 'p@ss' } },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(build()(request as any, failingNext(error))).rejects.toBe(error);
      expect(capture).toHaveBeenCalledWith(error, 'strapi_server', { request_method: 'PUT', status_code: 500 });
      expect(JSON.stringify(capture.mock.calls[0].slice(1))).not.toMatch(/secret-api-token|p@ss/);
    });

    it('サーバ: 送信が失敗しても、送信の例外ではなく元の例外を再送出する', async () => {
      const error = new Error('original');
      capture.mockRejectedValueOnce(new Error('posthog down'));

      await expect(build()(ctx(), failingNext(error))).rejects.toBe(error);
    });
  });
});
