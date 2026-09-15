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
const isExpectedError = (error: unknown) =>
  error instanceof errors.ApplicationError ||
  (error instanceof errors.HttpError && error.status < 500);

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
