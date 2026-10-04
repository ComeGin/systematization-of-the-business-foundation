import { AsyncLocalStorage } from 'node:async_hooks';

import type { Core } from '@strapi/strapi';
import type { Event } from '@strapi/database';

import { capturePostHogEvent, shutdownPostHog } from './posthog';

const POSTHOG_DISTINCT_ID = 'strapi_cms';
const ARTICLE_UID = 'api::article.article';

// Strapi 5 の unpublish は公開版の行を削除し（entries.delete）、記事の削除は下書きと公開版の行を
// 1 行ずつ削除する。どちらも DB のライフサイクルには行ごとの afterDelete として現れるため、そのままでは
// 非公開化が article_deleted になり、削除は article_deleted が 2 件出る。
// Document Service のミドルウェアが unpublish と delete を 1 操作 1 件として送り、その最中の
// afterDelete は送らない。この印がある間は afterDelete を送らず、無いとき（Document Service を通らない
// DB の直接の削除など）だけ保険として送る。
const documentOperationScope = new AsyncLocalStorage<true>();

const DOCUMENT_OPERATION_EVENTS: Record<string, string> = {
  unpublish: 'article_unpublished',
  delete: 'article_deleted',
};

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
  register({ strapi }: { strapi: Core.Strapi }) {
    // 非公開化（BA-05 では承認が要る操作）を通常の更新・削除と区別して送る（DD-04 の 2.4 の穴 1）。
    // あわせて、削除を documentId ごとに 1 件だけ送る。
    strapi.documents.use(async (context, next) => {
      const eventName = DOCUMENT_OPERATION_EVENTS[context.action];

      if (context.uid !== ARTICLE_UID || !eventName) {
        return next();
      }

      const result = await documentOperationScope.run(true, next);
      const operated = result as { documentId?: string; entries?: Array<{ locale?: string | null }> } | null;
      const params = (context.params ?? {}) as { documentId?: string; locale?: string };
      const entries = operated?.entries ?? [];

      // 公開版が無く何も非公開化しなかった呼び出しや、対象が無かった削除は、イベントにしない。
      if (entries.length > 0) {
        await capturePostHogEvent(POSTHOG_DISTINCT_ID, eventName, {
          content_type: 'article',
          document_id: operated?.documentId ?? params.documentId,
          locale: entries[0]?.locale ?? params.locale,
          $process_person_profile: false,
        });
      }

      return result;
    });
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    strapi.db.lifecycles.subscribe({
      models: [ARTICLE_UID],
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
        if (documentOperationScope.getStore()) {
          return;
        }

        await captureArticleEvent('article_deleted', event);
      },
    });
  },

  async destroy() {
    await shutdownPostHog();
  },
};
