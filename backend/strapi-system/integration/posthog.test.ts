// I-01（記事のイベント）と I-02（例外）の結合テスト。Strapi をテストのプロセスの中で起動し（helpers/strapi-instance.ts）、
// 送り先の PostHog だけを偽の HTTP サーバ（helpers/fake-posthog.ts）にする。src/index.ts・src/posthog.ts・
// src/middlewares/posthog-error.ts は dist のコンパイル結果がそのまま動く（単体テストのようにモックしない）。
//
// 送信は記事の保存・例外の応答の前に待つ（flush を await する）ので、Document Service の呼び出しや HTTP の応答が返った時点で
// 偽の PostHog に届いている。届かないことを確かめるときだけ、自動捕捉（enableExceptionAutocapture）の遅れを見込んで少し待つ。
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FakePostHog } from './helpers/fake-posthog';
import { APP_DIR, createFullAccessToken, startStrapi, type StrapiHarness } from './helpers/strapi-instance';

const ARTICLE = 'api::article.article';

// src/middlewares/posthog-error.ts と同じ @strapi/utils（instanceof の判定が同じクラスで行われるように、アプリから解決する）
const { errors } = createRequire(join(APP_DIR, 'package.json'))('@strapi/utils') as typeof import('@strapi/utils');

const marker = () => `it-${randomBytes(4).toString('hex')}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const posthog = new FakePostHog();
let app: StrapiHarness;
let token = '';
/** テスト用ルートが投げる例外のメッセージ（テストごとに変えて、届いた $exception を見分ける） */
let boomMessage = 'it-boom';

beforeAll(async () => {
  const host = await posthog.start();
  app = await startStrapi({
    posthogHost: host,
    routes: [
      {
        method: 'GET',
        path: '/it/boom',
        handler: () => {
          throw new Error(boomMessage);
        },
        config: { auth: false },
      },
      {
        method: 'GET',
        path: '/it/application-error',
        handler: () => {
          throw new errors.ApplicationError(boomMessage);
        },
        config: { auth: false },
      },
      {
        method: 'GET',
        path: '/it/not-found',
        handler: (ctx) => ctx.throw(404, boomMessage),
        config: { auth: false },
      },
      {
        method: 'GET',
        path: '/it/ok',
        handler: (ctx) => {
          ctx.body = { ok: true };
        },
        config: { auth: false },
      },
    ],
  });
  token = await createFullAccessToken(app.strapi);
});

afterEach(() => {
  posthog.mode = 'ok';
});

afterAll(async () => {
  await app?.stop();
  await posthog.stop();
});

const articles = () => app.strapi.documents(ARTICLE);

const api = async (path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) => {
  const { auth = true, body, method = 'GET' } = init;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${app.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
};

describe('I-01 記事のイベント（Document Service）', () => {
  describe('正常系', () => {
    it('作成・更新・公開・非公開化・削除が、1 操作 1 件のイベントとして順に届く', async () => {
      const created = await articles().create({ data: { title: marker() } });
      const { documentId } = created;
      await articles().update({ documentId, data: { title: marker() } });
      await articles().publish({ documentId });
      await articles().unpublish({ documentId });
      await articles().delete({ documentId });

      expect(posthog.eventsFor(documentId)).toEqual([
        'article_created',
        'article_updated',
        'article_published',
        'article_unpublished',
        'article_deleted',
      ]);
    });

    it('どのイベントも distinct_id は strapi_cms、$process_person_profile: false で、本文・タイトルを載せない', async () => {
      const title = marker();
      const { documentId } = await articles().create({ data: { title, description: '本文に近い値' } });
      await articles().delete({ documentId });

      const sent = posthog.events.filter((e) => e.properties.document_id === documentId);
      expect(sent).toHaveLength(2);
      for (const e of sent) {
        expect(e.distinct_id).toBe('strapi_cms');
        expect(e.properties).toMatchObject({ content_type: 'article', $process_person_profile: false });
        expect(JSON.stringify(e.properties)).not.toContain(title);
      }
    });

    it('公開済みの記事を公開し直しても article_deleted は送らない（古い公開版の行の置き換えは削除ではない）', async () => {
      // Strapi 5 の publish は古い公開版の行を消してから作り直す。以前はその afterDelete が article_deleted として
      // 送られていた（2026-10-07 に修正。src/index.ts の ROW_REPLACING_ACTIONS）
      const { documentId } = await articles().create({ data: { title: marker() } });
      await articles().publish({ documentId });
      await articles().update({ documentId, data: { title: marker() } });
      await articles().publish({ documentId });
      // update に status: published を付けると、内部で publish が呼ばれる（Content API の PUT ?status=published と同じ）
      await articles().update({ documentId, data: { title: marker() }, status: 'published' });
      await articles().delete({ documentId });

      expect(posthog.eventsFor(documentId)).toEqual([
        'article_created',
        'article_published',
        'article_updated',
        'article_published',
        'article_updated',
        'article_published',
        'article_deleted',
      ]);
    });

    it('下書きの破棄（discardDraft）は article_created も article_deleted も送らない（下書きを公開版に戻すだけ）', async () => {
      // discardDraft は古い下書きの行を消し、公開版から下書きを作り直す。以前はその行の作成と削除が
      // article_created・article_deleted として送られていた（2026-10-07 に修正）
      const { documentId } = await articles().create({ data: { title: marker() } });
      await articles().publish({ documentId });
      await articles().update({ documentId, data: { title: marker() } });
      await articles().discardDraft({ documentId });
      await articles().delete({ documentId });

      expect(posthog.eventsFor(documentId)).toEqual(['article_created', 'article_published', 'article_updated', 'article_deleted']);
    });

    it('空入力: data {} の作成でも article_created が 1 件届く（article に必須の項目は無い）', async () => {
      const { documentId } = await articles().create({ data: {} });
      await articles().delete({ documentId });

      expect(posthog.eventsFor(documentId)).toEqual(['article_created', 'article_deleted']);
    });

    it('空入力: 公開版の無い記事の非公開化は、イベントを送らない', async () => {
      const { documentId } = await articles().create({ data: { title: marker() } });
      await articles().unpublish({ documentId });
      await articles().delete({ documentId });

      expect(posthog.eventsFor(documentId)).toEqual(['article_created', 'article_deleted']);
    });
  });

  describe('異常系', () => {
    it('サーバ: PostHog が 500 を返しても、記事の保存は成功する（イベントは失われる）', async () => {
      posthog.mode = 'error';
      const before = posthog.requests;

      const { documentId } = await articles().create({ data: { title: marker() } });

      expect(posthog.requests).toBeGreaterThan(before);
      expect(await articles().findOne({ documentId })).toMatchObject({ documentId });
      expect(posthog.eventsFor(documentId)).toEqual([]);
      posthog.mode = 'ok';
      await articles().delete({ documentId });
    });

    it('サーバ: PostHog に繋がらない（接続が切られる）ときも、記事の保存は成功する', async () => {
      posthog.mode = 'down';

      const { documentId } = await articles().create({ data: { title: marker() } });

      expect(await articles().findOne({ documentId })).toMatchObject({ documentId });
      posthog.mode = 'ok';
      await articles().delete({ documentId });
    });

    it('サーバ: PostHog が応答しないときは 5 秒で見切り、記事の保存を待たせ続けない（POSTHOG_TIMEOUT_MS）', async () => {
      posthog.mode = 'slow';
      posthog.delayMs = 15_000;

      const started = Date.now();
      const { documentId } = await articles().create({ data: { title: marker() } });
      const elapsed = Date.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(8_000);
      expect(await articles().findOne({ documentId })).toMatchObject({ documentId });
      posthog.mode = 'ok';
      await articles().delete({ documentId });
    });
  });
});

describe('I-01 記事のイベント（Content API）', () => {
  describe('正常系', () => {
    it('POST（下書き）・PUT・DELETE がそれぞれイベントになる', async () => {
      const created = await api('/api/articles?status=draft', { method: 'POST', body: { data: { title: marker() } } });
      expect(created.status).toBe(201);
      const documentId = (created.json?.data as { documentId: string }).documentId;

      const updated = await api(`/api/articles/${documentId}?status=draft`, { method: 'PUT', body: { data: { title: marker() } } });
      expect(updated.status).toBe(200);
      const removed = await api(`/api/articles/${documentId}`, { method: 'DELETE' });
      expect(removed.status).toBe(204);

      expect(posthog.eventsFor(documentId)).toEqual(['article_created', 'article_updated', 'article_deleted']);
    });
  });

  describe('異常系', () => {
    it('入力: 検証に落ちた作成（description が 80 文字超）は 400 で、イベントも例外も送らない', async () => {
      const title = marker();
      const before = posthog.events.length;

      const res = await api('/api/articles', { method: 'POST', body: { data: { title, description: 'あ'.repeat(81) } } });

      expect(res.status).toBe(400);
      await pause(1_000);
      expect(posthog.events.slice(before)).toEqual([]);
    });

    it('空入力: data の無い本文 {} は 400 で、イベントも例外も送らない', async () => {
      const before = posthog.events.length;

      const res = await api('/api/articles', { method: 'POST', body: {} });

      expect(res.status).toBe(400);
      await pause(1_000);
      expect(posthog.events.slice(before)).toEqual([]);
    });
  });
});

describe('I-02 例外（global::posthog-error）', () => {
  describe('正常系', () => {
    it('成功した要求では $exception を送らない', async () => {
      const before = posthog.events.length;

      const res = await api('/it/ok', { auth: false });

      expect(res.status).toBe(200);
      expect(posthog.events.slice(before).filter((e) => e.event === '$exception')).toEqual([]);
    });
  });

  describe('異常系', () => {
    it('サーバ: ハンドリングされない例外は 500 になり、$exception が届く（distinct_id は strapi_server、要求のメソッド付き）', async () => {
      boomMessage = marker();

      const res = await api('/it/boom', { auth: false });

      expect(res.status).toBe(500);
      const [exception] = posthog.exceptionsWith(boomMessage);
      expect(exception?.distinct_id).toBe('strapi_server');
      expect(exception?.properties).toMatchObject({ request_method: 'GET' });
    });

    it('サーバ: 同じ例外は 1 件だけ記録される（自動捕捉との二重捕捉が無い。DD-04 の 3.4 の穴 3）', async () => {
      boomMessage = marker();

      await api('/it/boom', { auth: false });
      await pause(2_000);

      expect(posthog.exceptionsWith(boomMessage)).toHaveLength(1);
    });

    it('サーバ: PostHog が落ちていても、元の例外の応答（500）は返る', async () => {
      posthog.mode = 'down';
      boomMessage = marker();

      const res = await api('/it/boom', { auth: false });

      expect(res.status).toBe(500);
    });

    it('サーバ: PostHog が応答しないときも、500 の応答は 5 秒の見切りの後に返る', async () => {
      posthog.mode = 'slow';
      posthog.delayMs = 15_000;
      boomMessage = marker();

      const started = Date.now();
      const res = await api('/it/boom', { auth: false });

      expect(res.status).toBe(500);
      expect(Date.now() - started).toBeLessThan(8_000);
    });

    it('入力: ApplicationError（想定内のクライアント応答。400）は送らない', async () => {
      boomMessage = marker();

      const res = await api('/it/application-error', { auth: false });
      await pause(1_000);

      expect(res.status).toBe(400);
      expect(posthog.exceptionsWith(boomMessage)).toEqual([]);
    });

    it('入力: koa の ctx.throw(404)（Strapi の errors と別の版の http-errors）は送らない', async () => {
      // 以前は instanceof errors.HttpError で判定していて、koa の版の http-errors で作られた 404 が $exception として
      // 送られていた（2026-10-07 に修正。src/middlewares/posthog-error.ts の isClientHttpError）
      boomMessage = marker();

      const res = await api('/it/not-found', { auth: false });
      await pause(1_000);

      expect(res.status).toBe(404);
      expect(posthog.exceptionsWith(boomMessage)).toEqual([]);
    });

    it('入力: 存在しない documentId（NotFoundError）・トークン無し（401。Public ロールに権限が無い）・不正なトークン（401）は送らない', async () => {
      const before = posthog.events.length;

      const notFound = await api('/api/articles/itnotexist0000000000000000');
      const noToken = await api('/api/articles', { auth: false });
      const badToken = await fetch(`${app.baseUrl}/api/articles`, { headers: { authorization: 'Bearer it-invalid-token' } });
      await pause(1_000);

      expect([notFound.status, noToken.status, badToken.status]).toEqual([404, 401, 401]);
      expect(posthog.events.slice(before).filter((e) => e.event === '$exception')).toEqual([]);
    });
  });
});
