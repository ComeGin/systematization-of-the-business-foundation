import type { Core } from '@strapi/strapi';
import type { Event } from '@strapi/database';

import { capturePostHogEvent, shutdownPostHog } from './posthog';

const POSTHOG_DISTINCT_ID = 'strapi_cms';

const getArticleProperties = (event: Event) => {
  const data = (event.params.data ?? {}) as Record<string, unknown>;
  const result = (event.result ?? {}) as Record<string, unknown>;
  const where = (event.params.where ?? {}) as Record<string, unknown>;

  return {
    content_type: 'article',
    document_id: result.documentId ?? where.documentId ?? result.id ?? where.id,
    locale: result.locale ?? data.locale,
    $process_person_profile: false,
  };
};

const captureArticleEvent = (eventName: string, event: Event) =>
  capturePostHogEvent(POSTHOG_DISTINCT_ID, eventName, getArticleProperties(event));

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    strapi.db.lifecycles.subscribe({
      models: ['api::article.article'],
      async afterCreate(event) {
        const data = (event.params.data ?? {}) as Record<string, unknown>;

        await captureArticleEvent(data.publishedAt ? 'article_published' : 'article_created', event);
      },
      async afterUpdate(event) {
        const data = (event.params.data ?? {}) as Record<string, unknown>;

        if ('publishedAt' in data && data.publishedAt) {
          await captureArticleEvent('article_published', event);
          return;
        }

        await captureArticleEvent('article_updated', event);
      },
      async afterDelete(event) {
        await captureArticleEvent('article_deleted', event);
      },
    });
  },

  async destroy() {
    await shutdownPostHog();
  },
};
