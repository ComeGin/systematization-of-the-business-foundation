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
type App = typeof app;

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

const setup = (target: App = app): { subscriber: Subscriber; middleware: DocumentMiddleware } => {
  const fake = createFakeStrapi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target.register({ strapi: fake.strapi as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target.bootstrap({ strapi: fake.strapi as any });
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
const shutdown = vi.mocked(shutdownPostHog);

beforeEach(() => {
  capture.mockClear();
  shutdown.mockClear();
});

describe('bootstrap: 記事のライフサイクルの購読', () => {
  describe('正常系', () => {
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

    it('空入力: publishedAt が空文字の作成・更新は公開として扱わない', async () => {
      const { subscriber } = setup();

      await subscriber.afterCreate(lifecycleEvent({ data: { publishedAt: '' }, result: { documentId: 'doc1' } }));
      await subscriber.afterUpdate(lifecycleEvent({ data: { publishedAt: '' }, result: { documentId: 'doc1' } }));

      expect(capture.mock.calls.map(([, name]) => name)).toEqual(['article_created', 'article_updated']);
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

    it('記事の本文・タイトルなどの値はイベントに載せない', async () => {
      const { subscriber } = setup();

      await subscriber.afterCreate(
        lifecycleEvent({
          data: { title: '社外秘のタイトル', blocks: [{ body: '本文' }] },
          result: { documentId: 'doc1', title: '社外秘のタイトル' },
        })
      );

      expect(Object.keys(capture.mock.calls[0][2]).sort()).toEqual(
        ['$process_person_profile', 'content_type', 'document_id', 'locale'].sort()
      );
    });
  });

  describe('異常系', () => {
    it('サーバ: PostHog への送信が失敗したときは、その例外を Strapi のライフサイクルへ返す', async () => {
      // 実際の capturePostHogEvent は flush の失敗を握りつぶすため、ここまで届くのは想定外の失敗だけ
      // （失敗を握りつぶすことの確認は、このファイルの末尾の「PostHog の送信の失敗」で行う）
      const { subscriber } = setup();
      const error = new Error('unexpected');
      capture.mockRejectedValueOnce(error);

      await expect(subscriber.afterCreate(lifecycleEvent({ result: { documentId: 'a' } }))).rejects.toBe(error);
    });
  });
});

describe('bootstrap: イベントのプロパティの取り出し', () => {
  describe('正常系', () => {
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

    it('空入力: params.data と result が無くても例外にならない', async () => {
      const { subscriber } = setup();

      await subscriber.afterCreate({ params: {} });

      expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_created', {
        content_type: 'article',
        document_id: undefined,
        locale: undefined,
        $process_person_profile: false,
      });
    });

    it('空入力: params の data・where と result が空オブジェクトの更新・削除も document_id なしで送る', async () => {
      const { subscriber } = setup();

      await subscriber.afterUpdate(lifecycleEvent({ data: {}, where: {}, result: {} }));
      await subscriber.afterDelete({ params: {} });

      expect(capture.mock.calls.map(([, name, properties]) => [name, properties.document_id])).toEqual([
        ['article_updated', undefined],
        ['article_deleted', undefined],
      ]);
    });
  });
});

describe('bootstrap: afterDelete', () => {
  describe('正常系', () => {
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
});

describe('register: Document Service のミドルウェア', () => {
  describe('正常系', () => {
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

    it('空入力: 対象が無かった（entries が空の）操作はイベントにしない', async () => {
      const { middleware } = setup();
      const operated = { documentId: 'doc1', entries: [] };

      const result = await middleware({ uid: ARTICLE_UID, action: 'unpublish' }, async () => operated);

      expect(result).toBe(operated);
      expect(capture).not.toHaveBeenCalled();
    });

    it('空入力: 結果が null の操作はイベントにしない', async () => {
      const { middleware } = setup();

      const result = await middleware({ uid: ARTICLE_UID, action: 'delete' }, async () => null);

      expect(result).toBeNull();
      expect(capture).not.toHaveBeenCalled();
    });

    it('空入力: 結果が空オブジェクト（entries が無い）の操作はイベントにしない', async () => {
      const { middleware } = setup();

      const result = await middleware({ uid: ARTICLE_UID, action: 'delete' }, async () => ({}));

      expect(result).toEqual({});
      expect(capture).not.toHaveBeenCalled();
    });

    it('空入力: uid と action が空文字の操作はそのまま next に渡し、何も送らない', async () => {
      const { middleware } = setup();
      const next = vi.fn(async () => ({ entries: [{}] }));

      await middleware({ uid: '', action: '' }, next);

      expect(next).toHaveBeenCalledTimes(1);
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

    it('空入力: params が無く結果にも documentId が無いときは document_id なしで送る', async () => {
      const { middleware } = setup();

      await middleware({ uid: ARTICLE_UID, action: 'unpublish' }, async () => ({ entries: [{}] }));

      expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_unpublished', {
        content_type: 'article',
        document_id: undefined,
        locale: undefined,
        $process_person_profile: false,
      });
    });
  });

  describe('異常系', () => {
    it('サーバ: next が失敗（DB の例外）したときはイベントを送らずに例外をそのまま返す', async () => {
      const { middleware } = setup();
      const error = new Error('db failure');

      await expect(
        middleware({ uid: ARTICLE_UID, action: 'delete' }, async () => {
          throw error;
        })
      ).rejects.toBe(error);
      expect(capture).not.toHaveBeenCalled();
    });

    it('サーバ: next が途中で失敗しても、その後の afterDelete は再び送る（印が残らない）', async () => {
      const { subscriber, middleware } = setup();

      await expect(
        middleware({ uid: ARTICLE_UID, action: 'delete' }, async () => {
          // 1 行目の削除の後で 2 行目の削除が失敗した
          await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'doc1' } }));
          throw Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
        })
      ).rejects.toThrow('connection terminated unexpectedly');
      await subscriber.afterDelete(lifecycleEvent({ result: { documentId: 'other' } }));

      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledWith('strapi_cms', 'article_deleted', expect.objectContaining({ document_id: 'other' }));
    });

    it('サーバ: PostHog への送信が失敗したときは、その例外を Document Service へ返す', async () => {
      // 実際の capturePostHogEvent は flush の失敗を握りつぶす（このファイルの末尾で確認する）
      const { middleware } = setup();
      const error = new Error('unexpected');
      capture.mockRejectedValueOnce(error);

      await expect(
        middleware({ uid: ARTICLE_UID, action: 'unpublish' }, async () => ({ documentId: 'd', entries: [{}] }))
      ).rejects.toBe(error);
    });
  });
});

describe('destroy', () => {
  describe('正常系', () => {
    it('PostHog のクライアントを shutdown する', async () => {
      await app.destroy();

      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('異常系', () => {
    it('サーバ: shutdown が失敗したときは例外をそのまま返す', async () => {
      const error = new Error('network down');
      shutdown.mockRejectedValueOnce(error);

      await expect(app.destroy()).rejects.toBe(error);
    });
  });
});

// ここだけは src/posthog を偽物にせず、posthog-node だけを偽物にして、送信の失敗が記事の操作を止めないことを確かめる。
// vi.doUnmock・vi.doMock は以後の import にだけ効くため、上のテストが使う app（静的 import 済み）には影響しない
describe('bootstrap・register: PostHog の送信の失敗', () => {
  const loadAppWithFailingPostHog = async (flush: () => Promise<void>) => {
    class FailingPostHog {
      capture() {}
      captureException() {}
      flush = flush;
      async shutdown() {}
    }
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test_token');
    vi.stubEnv('POSTHOG_HOST', 'https://posthog.example.test');
    vi.doUnmock('../src/posthog');
    vi.doMock('posthog-node', () => ({ PostHog: FailingPostHog }));
    vi.resetModules();
    return (await import('../src/index')).default;
  };

  describe('異常系', () => {
    it('サーバ: flush が 503 で失敗しても afterCreate は例外を出さない（記事の保存を止めない）', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const realApp = await loadAppWithFailingPostHog(async () => {
        throw new Error('503 Service Unavailable');
      });
      const { subscriber } = setup(realApp);

      await expect(subscriber.afterCreate(lifecycleEvent({ result: { documentId: 'a' } }))).resolves.toBeUndefined();
      // 本物の src/posthog を通ったこと（偽物の capturePostHogEvent ではログは出ない）
      expect(errorSpy).toHaveBeenCalledWith('PostHog flush failed', expect.any(Error));
      expect(capture).not.toHaveBeenCalled();
    });

    it('サーバ: flush が通信失敗でも unpublish の結果をそのまま返す', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const realApp = await loadAppWithFailingPostHog(async () => {
        throw new TypeError('fetch failed');
      });
      const { middleware } = setup(realApp);
      const operated = { documentId: 'doc1', entries: [{ locale: 'ja-JP' }] };

      await expect(middleware({ uid: ARTICLE_UID, action: 'unpublish' }, async () => operated)).resolves.toBe(operated);
      expect(errorSpy).toHaveBeenCalledWith('PostHog flush failed', expect.any(TypeError));
    });

    it('サーバ: flush が終わらなくても 5 秒で afterUpdate が終わる', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const realApp = await loadAppWithFailingPostHog(() => new Promise(() => {}));
      const { subscriber } = setup(realApp);
      vi.useFakeTimers();

      try {
        const pending = subscriber.afterUpdate(lifecycleEvent({ result: { documentId: 'a' } }));
        await vi.advanceTimersByTimeAsync(5000);

        await expect(pending).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('PostHog flush timed out after 5000ms');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
