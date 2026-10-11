// 開発の Strapi（127.0.0.1:1337）を外から試す。I-09 と I-16 を 1 つのファイルにまとめているのは、
// 後片付け（削除）と公開に使う管理者のログインが 5 分に 5 回までに制限されているため（@strapi/admin の rateLimit）。
// ファイルを分けるとログインが実行ごとに 2 回になり、続けて実行すると 429 で止まる。
//
// I-09 Strapi → Astro（ビルド時のデータ取得）: Content API を、ビルドと同じ読み取り専用トークン（STRAPI_BUILD_TOKEN）で読む。
//   公開は人間（R2）が管理画面で行う操作なので、準備では管理者で公開する（ADR-17）。
// I-16 エージェント → Strapi（strapi-mcp。組み込みの /mcp）: MCP SDK の Client で、エージェントと同じ Admin トークン
//   （STRAPI_DEV_TOKEN。下書きまで）を使う。権限の境界（公開・非公開化・削除ができない）は、ツール一覧に出ないことと、
//   同じトークンで管理 API を直接叩いても 403 になることの両方で確かめる（ツールを隠すだけでは、トークンを持ち出されたときに
//   守れないため。DD-03 の 4.2 の代替 C）。このトークンには削除の権限が無いので、作ったものは管理者で消す（strapi.ts の adminDelete）。
//
// 外から起こせる 5xx は無いため、サーバ側のエラー（PostHog の障害・ハンドリングされない例外）は
// backend/strapi-system/integration/ のインプロセスの Strapi で確かめる。
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Cleanup } from "../helpers/cleanup.ts";
import { http } from "../helpers/http.ts";
import { itName, RUN_ID } from "../helpers/run-id.ts";
import { DEV } from "../helpers/services.ts";
import {
  ARTICLE,
  CATEGORY,
  adminApi,
  CONTENT_PLAN,
  KEYWORD,
  adminCreate,
  adminDelete,
  adminPublish,
  buildToken,
  callTool,
  connectMcp,
  contentApi,
  contentManager,
  devToken,
} from "./strapi.ts";

interface Doc {
  documentId: string;
  [key: string]: unknown;
}
interface ArticleRow {
  documentId: string;
  title: string;
  slug: string | null;
  publishedAt: string | null;
  category?: { name?: string } | null;
}
interface ListBody<T> {
  data: T[];
  meta: { pagination: { page: number; pageSize: number; total: number } };
}
interface ErrorBody {
  error?: { status?: number; name?: string; message?: string };
}

const cleanup = new Cleanup();
let client: Client;

/** 作ったドキュメントをすぐ後片付けに登録する */
function track(uid: string, documentId: string | undefined): string {
  if (!documentId) throw new Error(`${uid} の作成の応答に documentId が無い`);
  cleanup.add(`${uid} ${documentId}`, () => adminDelete(uid, documentId));
  return documentId;
}

const published = { title: itName("published"), slug: itName("published"), documentId: "" };
const draftOnly = { title: itName("draft"), documentId: "" };

beforeAll(async () => {
  const categoryId = track(CATEGORY, await adminCreate(CATEGORY, { name: itName("category"), slug: itName("category") }));
  published.documentId = track(ARTICLE, await adminCreate(ARTICLE, { title: published.title, slug: published.slug, description: "結合テストの公開記事", category: categoryId }));
  await adminPublish(ARTICLE, published.documentId);
  draftOnly.documentId = track(ARTICLE, await adminCreate(ARTICLE, { title: draftOnly.title, description: "結合テストの下書き" }));

  client = await connectMcp(devToken());
});

afterAll(async () => {
  await client?.close();
  await cleanup.runAll();
});

/** この実行で作った記事だけに絞る（他の担当・手作業の記事と混ぜない） */
const mine = `filters[title][$startsWith]=${encodeURIComponent(RUN_ID)}`;

describe("I-09 GET /api/articles（ビルド用の読み取りトークン）", () => {
  describe("正常系", () => {
    it("公開した記事だけが一覧に出て、populate で関連（カテゴリ）まで読める", async () => {
      const res = await contentApi<ListBody<ArticleRow>>(`/articles?${mine}&populate=*`, { token: buildToken() });

      expect(res.status).toBe(200);
      expect(res.json?.data.map((a) => a.title)).toEqual([published.title]);
      const [article] = res.json!.data;
      expect(article).toMatchObject({ documentId: published.documentId, slug: published.slug });
      expect(article!.publishedAt).toEqual(expect.any(String));
      expect(article!.category?.name).toBe(itName("category"));
    });

    it("documentId で 1 件を読める（findOne）", async () => {
      const res = await contentApi<{ data: ArticleRow }>(`/articles/${published.documentId}`, { token: buildToken() });

      expect(res.status).toBe(200);
      expect(res.json?.data.title).toBe(published.title);
    });

    it("pageSize は maxLimit（100）で頭打ちになる（config/api.ts）", async () => {
      const res = await contentApi<ListBody<ArticleRow>>(`/articles?${mine}&pagination[pageSize]=1000`, { token: buildToken() });

      expect(res.status).toBe(200);
      expect(res.json?.meta.pagination.pageSize).toBe(100);
    });

    it("空入力: 当てはまる記事が無い条件では 200 で data が空（0 件の判定はビルドの側で行う。DD-05 の 1.2）", async () => {
      const res = await contentApi<ListBody<ArticleRow>>(`/articles?filters[title][$eq]=${encodeURIComponent(itName("none"))}`, { token: buildToken() });

      expect(res.status).toBe(200);
      expect(res.json?.data).toEqual([]);
      expect(res.json?.meta.pagination.total).toBe(0);
    });
  });

  describe("異常系", () => {
    it("入力: 読み取りトークンでは記事を作成・更新・削除できない（403）", async () => {
      const create = await contentApi<ErrorBody>("/articles", { method: "POST", token: buildToken(), body: { data: { title: itName("forbidden") } } });
      const update = await contentApi<ErrorBody>(`/articles/${published.documentId}`, { method: "PUT", token: buildToken(), body: { data: { title: itName("forbidden") } } });
      const remove = await contentApi<ErrorBody>(`/articles/${published.documentId}`, { method: "DELETE", token: buildToken() });

      expect([create.status, update.status, remove.status]).toEqual([403, 403, 403]);
      expect(create.json?.error?.name).toBe("ForbiddenError");
      // 拒否された更新・削除が何も変えていない
      const after = await contentApi<{ data: ArticleRow }>(`/articles/${published.documentId}`, { token: buildToken() });
      expect(after.json?.data.title).toBe(published.title);
    });

    it("入力: 不正なトークンは 401", async () => {
      const res = await contentApi<ErrorBody>(`/articles?${mine}`, { token: "it-invalid-token-0000000000000000" });

      expect(res.status).toBe(401);
      expect(res.json?.error?.name).toBe("UnauthorizedError");
    });

    it("入力: Admin トークン（STRAPI_DEV_TOKEN）は Content API には使えない（401。トークンの種類が分かれている）", async () => {
      const res = await contentApi<ErrorBody>(`/articles?${mine}`, { token: devToken() });

      expect(res.status).toBe(401);
    });

    it("入力: トークン無しでは E-01（keyword）・E-03（content-plan）を読めない（401）", async () => {
      const keywords = await contentApi<ErrorBody>("/keywords");
      const plans = await contentApi<ErrorBody>("/content-plans");

      expect([keywords.status, plans.status]).toEqual([401, 401]);
    });

    it("入力: 存在しない documentId は 404", async () => {
      const res = await contentApi<ErrorBody>("/articles/itnotexist0000000000000000", { token: buildToken() });

      expect(res.status).toBe(404);
      expect(res.json?.error?.name).toBe("NotFoundError");
    });

    it("入力: 知らないクエリパラメータ・存在しない項目での絞り込みは 400（strictParams。config/api.ts）", async () => {
      const unknownParam = await contentApi<ErrorBody>(`/articles?${mine}&it_unknown=1`, { token: buildToken() });
      const unknownField = await contentApi<ErrorBody>("/articles?filters[it_unknown][$eq]=1", { token: buildToken() });

      expect([unknownParam.status, unknownField.status]).toEqual([400, 400]);
      expect(unknownParam.json?.error?.name).toBe("ValidationError");
    });

    it("空入力: 読み取りトークンで本文 {}・data 無しを送っても 403（検証より前に権限で止まる）", async () => {
      const empty = await contentApi<ErrorBody>("/keywords", { method: "POST", token: buildToken(), body: {} });
      const noData = await contentApi<ErrorBody>("/keywords", { method: "POST", token: buildToken(), body: { phrase: itName("nodata") } });

      expect([empty.status, noData.status]).toEqual([403, 403]);
    });

    it("入力: トークン無しでは公開記事も下書き（status=draft）も author も読めない（401。Public ロールに権限が 1 つも無い）", async () => {
      // scripts/seed.js が Public ロールに find を付けていたときは、?status=draft で下書きが、/authors で email が読めた
      // （2026-10-07 に修正。起動のたびに src/users-permissions-lockdown.ts が Public ロールの権限を全部外す）
      const list = await contentApi<ErrorBody>(`/articles?${mine}`);
      const drafts = await contentApi<ErrorBody>(`/articles?status=draft&filters[title][$eq]=${encodeURIComponent(draftOnly.title)}`);
      const one = await contentApi<ErrorBody>(`/articles/${published.documentId}`);
      const authors = await contentApi<ErrorBody>("/authors");

      expect([list.status, drafts.status, one.status, authors.status]).toEqual([401, 401, 401, 401]);
    });
  });
});

describe("I-16 strapi-mcp のツール一覧", () => {
  describe("正常系", () => {
    it("下書きまでの権限: 作成・読み取り・更新のツールだけが出て、公開・非公開化・削除のツールは出ない", async () => {
      const names = (await client.listTools()).tools.map((t) => t.name);

      for (const slug of ["article", "keyword", "content-plan"]) {
        expect(names).toEqual(expect.arrayContaining([`list_${slug}`, `get_${slug}`, `create_${slug}`, `update_${slug}`]));
      }
      expect(names.filter((n) => /^(publish|unpublish|delete)_/.test(n))).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: 認証ヘッダー無しでは接続できない（Authentication required）", async () => {
      await expect(connectMcp()).rejects.toThrow(/Authentication required/);
    });

    it("入力: 不正なトークンでは接続できない", async () => {
      await expect(connectMcp("it-invalid-token-0000000000000000")).rejects.toThrow(/Authentication required/);
    });

    it("入力: 一覧に無い publish_article を呼ぶとプロトコルのエラーになる（公開できない）", async () => {
      await expect(client.callTool({ name: "publish_article", arguments: { documentId: "itnotexist0000000000000000" } })).rejects.toThrow(/publish_article/);
    });
  });
});

describe("I-16 keyword（E-01）", () => {
  describe("正常系", () => {
    it("create_keyword で作り、update_keyword で採否を変えると、Content API から変えた値が読める", async () => {
      const phrase = itName("keyword");
      const created = await callTool<Doc>(client, "create_keyword", { data: { phrase, adoption_status: "candidate", intent_code: "latent", monthly_volume: 120 } });
      expect(created.isError).toBe(false);
      const documentId = track(KEYWORD, created.data?.documentId);
      expect(created.data).toMatchObject({ phrase, adoption_status: "candidate", intent_code: "latent", monthly_volume: 120 });

      const updated = await callTool<Doc>(client, "update_keyword", { documentId, data: { phrase, adoption_status: "adopted" } });
      expect(updated.isError).toBe(false);

      expect(updated.data).toMatchObject({ adoption_status: "adopted" });
      // ビルド用のトークンの Content API からも同じ値が読める
      const read = await contentApi<{ data: Doc }>(`/keywords/${documentId}`, { token: buildToken() });
      expect(read.status).toBe(200);
      expect(read.json?.data).toMatchObject({ phrase, adoption_status: "adopted" });
    });

    it("get_keyword で作ったものを documentId で読める", async () => {
      const phrase = itName("keyword-get");
      const created = await callTool<Doc>(client, "create_keyword", { data: { phrase, adoption_status: "candidate" } });
      const documentId = track(KEYWORD, created.data?.documentId);

      const got = await callTool<Doc>(client, "get_keyword", { documentId });

      expect(got.isError).toBe(false);
      expect(got.data).toMatchObject({ documentId, phrase });
    });

    it("get_keyword・list_keyword が E-01 の採否（adoption_status）を返し、adoption_status で絞り込める", async () => {
      // 属性名が status だったときは、Strapi 5 のドキュメントの状態（draft / published）と衝突して、get では採否が消え、
      // list では "published" に置き換わっていた（2026-10-07 に adoption_status へ改名）
      const adopted = await callTool<Doc>(client, "create_keyword", { data: { phrase: itName("kw-adopted"), adoption_status: "adopted" } });
      const adoptedId = track(KEYWORD, adopted.data?.documentId);
      const candidate = await callTool<Doc>(client, "create_keyword", { data: { phrase: itName("kw-candidate"), adoption_status: "candidate" } });
      track(KEYWORD, candidate.data?.documentId);

      const got = await callTool<Doc>(client, "get_keyword", { documentId: adoptedId });
      const listed = (await client.callTool({
        name: "list_keyword",
        arguments: { filters: { phrase: { $startsWith: itName("kw-") }, adoption_status: { $eq: "adopted" } } },
      })) as { structuredContent?: { results?: Doc[] } };

      expect(got.data).toMatchObject({ adoption_status: "adopted" });
      expect(listed.structuredContent?.results?.map((k) => [k.phrase, k.adoption_status])).toEqual([[itName("kw-adopted"), "adopted"]]);
    });
  });

  describe("異常系", () => {
    it("入力: enum 外の adoption_status は入力の検証で弾かれる（isError）", async () => {
      const res = await callTool(client, "create_keyword", { data: { phrase: itName("bad-status"), adoption_status: "it-bogus" } });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Input validation error.*data\.adoption_status/);
    });

    it("入力: 必須の phrase が無いと弾かれる", async () => {
      const res = await callTool(client, "create_keyword", { data: { adoption_status: "candidate" } });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/data\.phrase/);
    });

    it("入力: phrase の重複（unique）はサーバ側の検証で失敗する", async () => {
      const phrase = itName("dup");
      const first = await callTool<Doc>(client, "create_keyword", { data: { phrase, adoption_status: "candidate" } });
      track(KEYWORD, first.data?.documentId);

      const second = await callTool<Doc>(client, "create_keyword", { data: { phrase, adoption_status: "candidate" } });
      if (second.data?.documentId) track(KEYWORD, second.data.documentId);

      expect(second.isError).toBe(true);
      expect(second.text).toMatch(/unique/i);
    });

    it("入力: 存在しない documentId の get_keyword は Document not found", async () => {
      const res = await callTool(client, "get_keyword", { documentId: "itnotexist0000000000000000" });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/not found/i);
    });

    it("空入力: create_keyword に data {}・引数 {} を渡すと弾かれる", async () => {
      const emptyData = await callTool(client, "create_keyword", { data: {} });
      const noArgs = await callTool(client, "create_keyword", {});

      expect(emptyData.isError).toBe(true);
      expect(emptyData.text).toMatch(/data\.phrase/);
      expect(noArgs.isError).toBe(true);
      expect(noArgs.text).toMatch(/data: Invalid input/);
    });
  });
});

describe("I-16 content-plan（E-03）", () => {
  describe("正常系", () => {
    it("keyword に紐付けて起案し（drafted）、pending_approval に更新できる", async () => {
      const kw = await callTool<Doc>(client, "create_keyword", { data: { phrase: itName("plan-keyword"), adoption_status: "adopted" } });
      const keywordId = track(KEYWORD, kw.data?.documentId);

      const created = await callTool<Doc>(client, "create_content-plan", { data: { title_draft: itName("plan"), plan_state: "drafted", keyword: keywordId } });
      expect(created.isError).toBe(false);
      const planId = track(CONTENT_PLAN, created.data?.documentId);

      const updated = await callTool<Doc>(client, "update_content-plan", { documentId: planId, data: { title_draft: itName("plan"), plan_state: "pending_approval" } });
      expect(updated.isError).toBe(false);
      expect(updated.data).toMatchObject({ plan_state: "pending_approval" });

      // 紐付けは保存されている（ビルド用のトークンで populate して読む）
      const read = await contentApi<{ data: Doc & { keyword?: { documentId?: string } } }>(`/content-plans/${planId}?populate=keyword`, { token: buildToken() });
      expect(read.json?.data.keyword?.documentId).toBe(keywordId);
    });
  });

  describe("異常系", () => {
    it("入力: enum 外の plan_state は弾かれる", async () => {
      const res = await callTool(client, "create_content-plan", { data: { title_draft: itName("bad-plan"), plan_state: "it-bogus" } });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/data\.plan_state/);
    });

    it("空入力: create_content-plan に data {} を渡すと弾かれる", async () => {
      const res = await callTool(client, "create_content-plan", { data: {} });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/data\.title_draft/);
    });
  });
});

describe("I-16 article（E-04 の下書き）", () => {
  describe("正常系", () => {
    it("create_article・update_article は下書きのまま（publishedAt は null で、公開版の一覧に出ない）", async () => {
      const created = await callTool<Doc>(client, "create_article", { data: { title: itName("article"), description: "結合テストの下書き" } });
      expect(created.isError).toBe(false);
      const documentId = track(ARTICLE, created.data?.documentId);
      expect(created.data).toMatchObject({ publishedAt: null });

      const updated = await callTool<Doc>(client, "update_article", { documentId, data: { title: itName("article-v2") } });
      expect(updated.data).toMatchObject({ title: itName("article-v2"), publishedAt: null });

      const draft = await callTool<Doc>(client, "get_article", { documentId, status: "draft" });
      expect(draft.data).toMatchObject({ title: itName("article-v2") });
      const live = await contentApi<{ data: Doc[] }>(`/articles?filters[documentId][$eq]=${documentId}`, { token: buildToken() });
      expect(live.json?.data).toEqual([]);
    });
  });

  describe("異常系", () => {
    it("入力: data に publishedAt を入れても受け付けない（Unrecognized key）", async () => {
      const res = await callTool(client, "create_article", { data: { title: itName("publish-attempt"), publishedAt: "2026-10-07T00:00:00Z" } });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/publishedAt/);
    });

    it("入力: スキーマに無い status: published を付けて作成・更新しても公開されない", async () => {
      const created = await callTool<Doc>(client, "create_article", { data: { title: itName("status-attempt") }, status: "published" });
      const documentId = track(ARTICLE, created.data?.documentId);
      await callTool(client, "update_article", { documentId, data: { title: itName("status-attempt") }, status: "published" });

      const live = await contentApi<{ data: Doc[] }>(`/articles?filters[documentId][$eq]=${documentId}`, { token: buildToken() });
      expect(live.json?.data).toEqual([]);
    });

    it("入力: description が 80 文字を超えると弾かれる", async () => {
      const res = await callTool(client, "create_article", { data: { title: itName("long"), description: "あ".repeat(81) } });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/data\.description/);
    });

    it("入力: 存在しない documentId の update_article は失敗する", async () => {
      const res = await callTool(client, "update_article", { documentId: "itnotexist0000000000000000", data: { title: itName("ghost") } });

      expect(res.isError).toBe(true);
    });

    it("空入力: create_article に引数 {} を渡すと弾かれる", async () => {
      const res = await callTool(client, "create_article", {});

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Input validation error/);
    });
  });
});

describe("I-16 STRAPI_DEV_TOKEN で管理 API を直接叩く（ツールを隠すだけでなくトークンの権限で止まるか）", () => {
  let articleId = "";

  beforeAll(async () => {
    articleId = track(ARTICLE, await adminCreate(ARTICLE, { title: itName("boundary") }));
  });

  describe("正常系", () => {
    it("下書きの作成・読み取りはできる", async () => {
      const res = await contentManager<{ data: Doc }>(ARTICLE, `/${articleId}`, { token: devToken() });

      expect(res.status).toBe(200);
      expect(res.json?.data.title).toBe(itName("boundary"));
    });

    it("keyword を adoption_status 付きで作れる（R2 が管理画面で採否を付けられる。属性名が status のときは 400「Invalid status」だった）", async () => {
      const res = await contentManager<{ data?: Doc }>(KEYWORD, "", { method: "POST", token: devToken(), body: { phrase: itName("cm-adopted"), adoption_status: "adopted" } });
      track(KEYWORD, res.json?.data?.documentId);

      expect(res.status).toBe(201);
      expect(res.json?.data).toMatchObject({ adoption_status: "adopted" });
    });
  });

  describe("異常系", () => {
    it("入力: 公開（actions/publish）は 403", async () => {
      const res = await contentManager<ErrorBody>(ARTICLE, `/${articleId}/actions/publish`, { method: "POST", token: devToken(), body: {} });

      expect(res.status).toBe(403);
      expect(res.json?.error?.name).toBe("PolicyError");
    });

    it("入力: 削除は 403（記事は残る）", async () => {
      const res = await contentManager<ErrorBody>(ARTICLE, `/${articleId}`, { method: "DELETE", token: devToken() });

      expect(res.status).toBe(403);
      const still = await contentManager(ARTICLE, `/${articleId}`);
      expect(still.status).toBe(200);
    });

    it("入力: 必須の phrase が無い keyword は 400（ValidationError）", async () => {
      const res = await contentManager<ErrorBody>(KEYWORD, "", { method: "POST", token: devToken(), body: { intent_code: "latent" } });

      expect(res.status).toBe(400);
      expect(res.json?.error).toMatchObject({ name: "ValidationError", message: "phrase must be defined." });
    });

    it("入力: 存在しない documentId は 404", async () => {
      const res = await contentManager<ErrorBody>(KEYWORD, "/itnotexist0000000000000000", { token: devToken() });

      expect(res.status).toBe(404);
    });

    it("空入力: 本文 {} の keyword は 400（必須項目の欠落）", async () => {
      const res = await contentManager<ErrorBody>(KEYWORD, "", { method: "POST", token: devToken(), body: {} });

      expect(res.status).toBe(400);
      expect(res.json?.error?.name).toBe("ValidationError");
    });
  });
});

describe("users-permissions のエンドユーザーの認証（このシステムでは使わないので止める）", () => {
  describe("正常系", () => {
    it("advanced の allow_register が false（起動のたびに src/users-permissions-lockdown.ts がそろえる）", async () => {
      const res = await adminApi<{ settings?: { allow_register?: boolean } }>("/users-permissions/advanced");

      expect(res.status).toBe(200);
      expect(res.json?.settings?.allow_register).toBe(false);
    });
  });

  describe("異常系", () => {
    it("入力: トークン無しの POST /api/auth/local/register は拒否され（401）、ユーザーは作られない", async () => {
      const email = itName("register").toLowerCase() + "@example.com";

      const res = await http<ErrorBody>(`${DEV.strapi}/api/auth/local/register`, {
        method: "POST",
        body: { username: itName("register"), email, password: "ItPassw0rd-register" },
      });
      const users = await adminApi<{ results?: Doc[] }>(
        `/content-manager/collection-types/plugin::users-permissions.user?filters[email][$eq]=${encodeURIComponent(email)}`,
      );
      for (const u of users.json?.results ?? []) track("plugin::users-permissions.user", u.documentId);

      expect(res.status).toBe(401);
      expect(users.json?.results).toEqual([]);
    });

    it("入力: パスワードの再設定（forgot-password）・ログイン（auth/local）も拒否される（401）", async () => {
      const forgot = await http(`${DEV.strapi}/api/auth/forgot-password`, { method: "POST", body: { email: "it-nobody@example.com" } });
      const login = await http(`${DEV.strapi}/api/auth/local`, { method: "POST", body: { identifier: "it-nobody@example.com", password: "x" } });

      expect([forgot.status, login.status]).toEqual([401, 401]);
    });

    it("空入力: 本文 {} の register も 401（検証より前に権限で止まる）", async () => {
      const res = await http(`${DEV.strapi}/api/auth/local/register`, { method: "POST", body: {} });

      expect(res.status).toBe(401);
    });
  });
});
