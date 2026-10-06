import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/posthog', () => ({
  capturePostHogEvent: vi.fn(async () => {}),
  shutdownPostHog: vi.fn(async () => {}),
}));

import app from '../src/index';
import { capturePostHogEvent, shutdownPostHog } from '../src/posthog';

const ARTICLE_UID = 'api::article.article';

type Lifecycle = (event: unknown) => Promise<void>;
type Subscriber = {
  models: string[];
  afterCreate: Lifecycle;
  afterUpdate: Lifecycle;
  afterDelete: Lifecycle;
};
type DocumentMiddleware = (
  context: { uid: string; action: string; params?: Record<string, unknown> },
  next: () => Promise<unknown>
) => Promise<unknown>;

// strapi の偽物。db.lifecycles.subscribe と documents.use に渡されたものを記録するだけ
const createFakeStrapi = () => {
  const subscribers: Subscriber[] = [];
  const documentMiddlewares: DocumentMiddleware[] = [];
  const strapi = {
    db: { lifecycles: { subscribe: vi.fn((s: Subscriber) => subscribers.push(s)) } },
    documents: { use: vi.fn((m: DocumentMiddleware) => documentMiddlewares.push(m)) },
  };
  return { strapi, subscribers, documentMiddlewares };
};

const setup =(): { subscriber: Subscriber; middleware: DocumentMiddleware } => {
  const fake = createFakeStrapi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.register({ strapi: fake.strapi as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.bootstrap({ strapi: fake.strapi as any });
  return { subscriber: fake.subscribers[0], middleware: fake.documentMiddlewares[0] };
};

const lifecycleEvent = ({
  data,
  where,
  result,
}: {
  data?: Record<string, unknown>;
  where?: Record<string, unknown>;
  result?: Record<string, unknown>;
}) => ({ params: { data, where }, result });

const capture = vi.mocked(capturePostHogEvent);

beforeEach(() => {
  capture.mockClear();
});

describe('bootstrap: 記事のライフサイクルの購読', () => {
  it('api::article.article だけを購読する', () => {
    const { subscriber } = setup();

    expect(subscriber.models).toEqual([ARTICLE_UID]);
  });

  it('publishedAt の無い作成は article_created を送る', async () => {
    const { subscriber } = setup();

    await subscriber.afterCreate(
      lifecycleEvent({ data: { title: 't' }, result: { id: 1, documentId: 'doc1', locale: 'ja-JP' } })
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_created', {
      content_type: 'article',
      document_id: 'doc1',
      locale: 'ja-JP',
      $process_person_profile: false,
    });
  });

  it('publishedAt 付きの作成（公開版の行の作成）は article_published を送る', async () => {
    const { subscriber } = setup();

    await subscriber.afterCreate(
      lifecycleEvent({ data: { publishedAt: '2026-10-05T00:00:00Z' }, result: { documentId: 'doc1' } })
    );

    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_published', expect.any(Object));
  });

  it('publishedAt を値ありで更新すると article_published を送る', async () => {
    const { subscriber } = setup();

    await subscriber.afterUpdate(
      lifecycleEvent({ data: { publishedAt: '2026-10-05T00:00:00Z' }, result: { documentId: 'doc1' } })
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_published', expect.any(Object));
  });

  it('publishedAt を null にする更新は article_updated として送る', async () => {
    const { subscriber } = setup();

    await subscriber.afterUpdate(lifecycleEvent({ data: { publishedAt: null }, result: { documentId: 'doc1' } }));

    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_updated', expect.any(Object));
  });

  it('publishedAt を含まない更新は article_updated を送る', async () => {
    const { subscriber } = setup();

    await subscriber.afterUpdate(lifecycleEvent({ data: { title: 'new' }, result: { documentId: 'doc1' } }));

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_updated', expect.any(Object));
  });

  it('どのイベントも $process_person_profile: false を付け、person を作らない', async () => {
    const { subscriber } = setup();

    await subscriber.afterCreate(lifecycleEvent({ result: { documentId: 'a' } }));
    await subscriber.afterUpdate(lifecycleEvent({ result: { documentId: 'a' } }));
    await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'a' } }));

    expect(capture).toHaveBeenCalledTimes(3);
    for (const [, , properties] of capture.mock.calls) {
      expect(properties).toMatchObject({ $process_person_profile: false });
    }
  });
});

describe('bootstrap: イベントのプロパティの取り出し', () => {
  it('result に documentId が無ければ where.documentId を使う', async () => {
    const { subscriber } = setup();

    await subscriber.afterUpdate(lifecycleEvent({ where: { documentId: 'from-where' }, result: {} }));

    expect(capture.mock.calls[0][2]).toMatchObject({ document_id: 'from-where' });
  });

  it('documentId がどちらにも無ければ result.id、次に where.id を使う', async () => {
    const { subscriber } = setup();

    await subscriber.afterUpdate(lifecycleEvent({ where: { id: 9 }, result: { id: 7 } }));
    await subscriber.afterDelete(lifecycleEvent({ where: { id: 9 } }));

    expect(capture.mock.calls[0][2]).toMatchObject({ document_id: 7 });
    expect(capture.mock.calls[1][2]).toMatchObject({ document_id: 9 });
  });

  it('result に locale が無ければ data.locale を使う', async () => {
    const { subscriber } = setup();

    await subscriber.afterCreate(lifecycleEvent({ data: { locale: 'en' }, result: { documentId: 'd' } }));

    expect(capture.mock.calls[0][2]).toMatchObject({ locale: 'en' });
  });

  it('params.data と result が無くても例外にならない', async () => {
    const { subscriber } = setup();

    await subscriber.afterCreate({ params: {} });

    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_created', {
      content_type: 'article',
      document_id: undefined,
      locale: undefined,
      $process_person_profile: false,
    });
  });
});

describe('bootstrap: afterDelete', () => {
  it('Document Service を通らない削除では article_deleted を送る（保険）', async () => {
    const { subscriber } = setup();

    await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'doc1', locale: 'ja-JP' } }));

    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_deleted', {
      content_type: 'article',
      document_id: 'doc1',
      locale: 'ja-JP',
      $process_person_profile: false,
    });
  });
});

describe('register: Document Service のミドルウェア', () => {
  it('記事以外の操作はそのまま next に渡し、何も送らない', async () => {
    const { middleware } = setup();
    const next = vi.fn(async () => ({ documentId: 'x', entries: [{}] }));

    const result = await middleware({ uid: 'api::category.category', action: 'delete' }, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ documentId: 'x', entries: [{}] });
    expect(capture).not.toHaveBeenCalled();
  });

  it('記事でも unpublish・delete 以外の操作は何も送らない', async () => {
    const { middleware } = setup();
    const next = vi.fn(async () => ({ documentId: 'x', entries: [{}] }));

    await middleware({ uid: ARTICLE_UID, action: 'update' }, next);
    await middleware({ uid: ARTICLE_UID, action: 'publish' }, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
  });

  it('unpublish は article_unpublished を 1 件送り、その最中の afterDelete は送らない', async () => {
    const { subscriber, middleware } = setup();
    const operated = { documentId: 'doc1', entries: [{ locale: 'ja-JP' }] };
    const next = vi.fn(async () => {
      // 公開版の行の削除が DB のライフサイクルに afterDelete として現れる
      await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'doc1' } }));
      return operated;
    });

    const result = await middleware({ uid: ARTICLE_UID, action: 'unpublish', params: {} }, next);

    expect(result).toBe(operated);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_unpublished', {
      content_type: 'article',
      document_id: 'doc1',
      locale: 'ja-JP',
      $process_person_profile: false,
    });
  });

  it('delete は下書きと公開版の 2 行の afterDelete があっても article_deleted を 1 件だけ送る', async () => {
    const { subscriber, middleware } = setup();
    const next = vi.fn(async () => {
      await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'doc1' } }));
      await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'doc1' } }));
      return { documentId: 'doc1', entries: [{ locale: 'ja-JP' }, { locale: 'ja-JP' }] };
    });

    await middleware({ uid: ARTICLE_UID, action: 'delete', params: {} }, next);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_deleted', expect.any(Object));
  });

  it('ミドルウェアの操作が終わった後の afterDelete は再び送る', async () => {
    const { subscriber, middleware } = setup();

    await middleware({ uid: ARTICLE_UID, action: 'delete' }, async () => ({ documentId: 'a', entries: [] }));
    await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'b' } }));

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_deleted', expect.objectContaining({ document_id: 'b' }));
  });

  it('対象が無かった（entries が空の）操作はイベントにしない', async () => {
    const { middleware } = setup();
    const operated = { documentId: 'doc1', entries: [] };

    const result = await middleware({ uid: ARTICLE_UID, action: 'unpublish' }, async () => operated);

    expect(result).toBe(operated);
    expect(capture).not.toHaveBeenCalled();
  });

  it('結果が null の操作はイベントにしない', async () => {
    const { middleware } = setup();

    const result = await middleware({ uid: ARTICLE_UID, action: 'delete' }, async () => null);

    expect(result).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it('結果に documentId・locale が無ければ params の値を使う', async () => {
    const { middleware } = setup();

    await middleware(
      { uid: ARTICLE_UID, action: 'delete', params: { documentId: 'from-params', locale: 'en' } },
      async () => ({ entries: [{ locale: null }] })
    );

    expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_deleted', {
      content_type: 'article',
      document_id: 'from-params',
      locale: 'en',
      $process_person_profile: false,
    });
  });

  it('next が失敗したときはイベントを送らずに例外をそのまま返す', async () => {
    const { middleware } = setup();
    const error = new Error('db failure');

    await expect(
      middleware({ uid: ARTICLE_UID, action: 'delete' }, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('destroy', () => {
  it('PostHog のクライアントを shutdown する', async () => {
    await app.destroy();

    expect(shutdownPostHog).toHaveBeenCalledTimes(1);
  });
});
