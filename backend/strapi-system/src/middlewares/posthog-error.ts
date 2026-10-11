import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

import { capturePostHogException } from '../posthog';

type MiddlewareContext = {
  state: {
    user?: {
      id?: string | number;
    };
  };
  method: string;
  status: number;
};

type Next = () => Promise<unknown>;

// Mirrors strapi::errors: ApplicationError and 4xx HttpError are expected client
// responses (e.g. the admin's "Preview config not found" 404), not server faults.
//
// 4xx の HttpError は instanceof で見分けない。koa の ctx.throw は koa が依存する版の http-errors（1.8 系）で
// 例外を作り、@strapi/utils の errors.HttpError（2.0 系）とはクラスが別になるため、instanceof が偽になる。
// http-errors はどの版でも status（数値）と expose（4xx なら true）を持つので、その 2 つで判定する。
// expose まで見るのは、上流の HTTP の失敗を status に写しただけの例外（HTTP クライアントのエラーなど）を
// クライアントの誤りとして捨てないため。
const isClientHttpError = (error: unknown) => {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const { status, expose } = error as { status?: unknown; expose?: unknown };

  return typeof status === 'number' && status >= 400 && status < 500 && expose === true;
};

const isExpectedError = (error: unknown) =>
  error instanceof errors.ApplicationError || isClientHttpError(error);

export default (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  strapi.log.debug('PostHog error tracking middleware initialized');

  return async (ctx: MiddlewareContext, next: Next) => {
    try {
      await next();
    } catch (error) {
      if (isExpectedError(error)) {
        throw error;
      }

      const userId = ctx.state.user?.id;
      const distinctId = userId ? `strapi-user-${String(userId)}` : 'strapi_server';

      try {
        await capturePostHogException(error, distinctId, {
          request_method: ctx.method,
          status_code: ctx.status,
        });
      } finally {
        throw error;
      }
    }
  };
};
