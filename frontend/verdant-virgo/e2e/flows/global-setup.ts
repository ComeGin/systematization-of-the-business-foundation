// E2E（pnpm e2e）の globalSetup。webServer（E2E の dev サーバー）が起動した後に 1 回だけ動く。
//   1. 開発スタックが動いているかを確かめる（落ちていれば何も作らずに止める）
//   2. テスト用データを作る: 開発の Strapi に記事 3 本（名前は e2e-<実行の ID>- で始める）
//        - adoption … 「導入を検討する」（顕在）の公開記事。記事中と記事末に無料相談の CTA が出る
//        - issues   … 「課題を知る」（潜在）の公開記事。無料相談の CTA は出ず、無料 DL の CTA が出る
//        - draft    … 公開しない下書き。公開サイトに出てはいけない
//      dev サーバーは表示のたびに Strapi から取り直す（blog/lib/articles.ts）ので、作った記事はすぐ画面に出る
//   3. 作ったものを環境変数 E2E_SEED でテストに渡し、戻り値の関数（globalTeardown の代わり）で消す。
//      チャットのテストが消せずに残した Chatwoot のコンタクト（訪問者がオンラインの間は消せない）も、ここで消す
import type { FullConfig } from "@playwright/test";
import {
  categoryDocumentId,
  createArticle,
  deleteArticle,
  deletePendingChatwootContacts,
  publishArticle,
  unreachableServices,
} from "./support/devstack";
import { E2E_BASE_URL, RUN_ID, e2eName } from "./support/env";

export interface SeedArticle {
  documentId: string;
  title: string;
  slug: string;
  description: string;
  /** 本文の段落（記事のページに出ることを確かめる） */
  paragraph: string;
  categorySlug: string;
}

export interface Seed {
  runId: string;
  adoption: SeedArticle;
  issues: SeedArticle;
  draft: SeedArticle;
}

function article(
  label: string,
  categorySlug: string,
  heading: string,
): Omit<SeedArticle, "documentId"> {
  const slug = e2eName(label);
  return {
    title: `E2E ${heading}（${RUN_ID}）`,
    slug,
    // 要約は 80 字まで（一覧のカードと meta description）
    description: `E2E のテスト記事（${label}）。終わったら消す。`,
    paragraph: `E2E の本文の確認用の段落です（${slug}）。`,
    categorySlug,
  };
}

export default async function globalSetup(_config: FullConfig) {
  const down = await unreachableServices();
  if (down.length > 0) {
    throw new Error(
      `開発スタックの一部が動いていない: ${down.join("、")}。node setup/setup.mjs --target dev --check で状態を確かめてから実行する`,
    );
  }
  // 前回の実行が途中で止まって残したコンタクトがあれば、先に消す
  await deletePendingChatwootContacts();

  const created: string[] = [];
  const make = async (
    spec: Omit<SeedArticle, "documentId">,
    publish: boolean,
  ): Promise<SeedArticle> => {
    const documentId = await createArticle({
      title: spec.title,
      slug: spec.slug,
      description: spec.description,
      category: await categoryDocumentId(spec.categorySlug),
      // 見出し（h2）を 1 つ入れる。記事中の CTA は最初の h2 の直前に入る（blog/[slug].astro）
      blocks: [
        {
          __component: "shared.rich-text",
          body: `${spec.paragraph}\n\n## E2E の見出し\n\n見出しの後の段落です。`,
        },
      ],
    });
    created.push(documentId);
    if (publish) await publishArticle(documentId);
    return { ...spec, documentId };
  };

  const teardown = async () => {
    const failures: string[] = [];
    for (const documentId of created.reverse()) {
      await deleteArticle(documentId).catch((error: unknown) =>
        failures.push(String(error)),
      );
    }
    // チャットのテストが、訪問者がオンラインの間で消せずに残したコンタクト（support/devstack.ts）
    await deletePendingChatwootContacts().catch((error: unknown) =>
      failures.push(String(error)),
    );
    if (failures.length > 0)
      throw new Error(
        `E2E のテストデータを消せなかった（手で消す）:\n${failures.join("\n")}`,
      );
  };

  try {
    const seed: Seed = {
      runId: RUN_ID,
      adoption: await make(
        article("adoption", "consider-adoption", "導入を検討する記事"),
        true,
      ),
      issues: await make(
        article("issues", "know-the-issues", "課題を知る記事"),
        true,
      ),
      draft: await make(
        article("draft", "consider-adoption", "公開しない下書き"),
        false,
      ),
    };
    process.env.E2E_SEED = JSON.stringify(seed);
    await warmUp(seed);
  } catch (error) {
    await teardown().catch(() => {});
    throw error;
  }
  return teardown;
}

/**
 * E2E が開くページを 1 回ずつ開いておく。dev サーバーはページを初めて開くときにその場で変換するため、
 * 冷えた状態の最初の遷移だけが十数秒かかり、最初に流れるテストの待ちを超える（2026-10-25 の実行で確認）
 */
async function warmUp(seed: Seed) {
  const paths = [
    "/",
    "/blog/",
    `/blog/category/${seed.adoption.categorySlug}/`,
    `/blog/${seed.adoption.slug}/`,
    `/blog/${seed.issues.slug}/`,
    "/services/",
    "/services/consulting/",
    "/pricing/",
    "/about/",
    "/contact/",
    "/contact/thanks/",
  ];
  for (const path of paths) {
    await fetch(`${E2E_BASE_URL}${path}`, { signal: AbortSignal.timeout(120_000) }).catch(() => {});
  }
}
