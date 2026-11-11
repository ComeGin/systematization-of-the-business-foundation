// build-info モジュール: ビルドの最後に dist/build-info.json（コミットとビルドの日時）を書く Astro インテグレーション。
// 目的は「配信中のサイトが、どのコミットから作られたか」を HTTPS で読めるようにすること。
// 監視アプリ（backend/control-plane の status/drift.ts）が、origin/main に公開サイトの変更が増えたのに
// 再配信していない状態を見つけるのに使う（docs/superpowers/specs/2026-11-03-setup-status-design.md の 5.3）。
// あわせて BUILD_COMMIT_SHA があるときだけ dist/_build.json も書く（下の BUILD_MARK_FILE）。
// あわせて articles（このビルドに含めた公開済みの記事の slug・publishedAt・updatedAt）を書く。監視アプリが
// 「Strapi で公開されたが、配信中のサイトにまだ入っていない記事」を見つけるのに使う（articles.ts）。取れなかったときは null。
// 公開される JSON なので、入れるのはコミットの SHA・ビルドの日時・記事の slug と日時だけ（秘密値・パス・ブランチ名・documentId は入れない）。
// コミットは、Astro のプロジェクトのルート（config.root。frontend/verdant-virgo）の `git rev-parse HEAD`。cwd には頼らない。取れなくてもビルドは止めず commit を null にする。
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AstroIntegration } from "astro";
import { loadEnv } from "vite";
import { fetchBuildArticles, type BuildArticle } from "./articles";

const execFileAsync = promisify(execFile);

export const BUILD_INFO_FILE = "build-info.json";
/**
 * 監視アプリ（control-plane の published-article-check）が配信用のビルドに渡した BUILD_COMMIT_SHA を、そのまま印として残すファイル。
 * 配信の確認が「公開サイトの _build.json の commit が deploy の項目のコミットと一致する」ことで行えるようにする（改善ループの spec 5.6）。
 * BUILD_COMMIT_SHA が無い（人が手でビルドした）ときは書かない。公開される JSON なので、入れるのはコミットとビルドの日時だけ。
 */
export const BUILD_MARK_FILE = "_build.json";

export interface BuildInfo {
  /** ビルドしたときの HEAD の 40 桁のコミット。git を読めなかったときは null */
  readonly commit: string | null;
  /** ビルドの完了時刻（ISO 8601、UTC） */
  readonly builtAt: string;
  /**
   * このビルドが Strapi から読んだ公開済みの記事（slug の昇順）。ビルドの開始時に取る。
   * Strapi から取れなかったときは null（監視アプリは記事の未配信を判定できない）。
   */
  readonly articles: readonly BuildArticle[] | null;
}

async function headCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 10_000,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function comeginBuildInfo(): AstroIntegration {
  let projectRoot = process.cwd();
  let articles: BuildArticle[] | null = null;
  return {
    name: "comegin-build-info",
    hooks: {
      "astro:config:done": ({ config }) => {
        projectRoot = fileURLToPath(config.root);
      },
      // 記事の本体を読む前（ビルドの開始時）に一覧を取る。ビルドの途中で公開された記事を「含めた」と記録しないため。
      // 環境変数は blog/integration.ts と同じく Vite の loadEnv で読む（設定ファイルでは自動で読み込まれないため）
      "astro:build:start": async ({ logger }) => {
        const env = loadEnv(process.env.NODE_ENV ?? "development", projectRoot, "");
        articles = await fetchBuildArticles(env);
        if (articles === null) {
          logger.warn(
            "Strapi から公開済みの記事の一覧を取れなかったため、build-info.json の articles は null です（監視アプリは記事の未配信を判定できません。ビルドは続けます）。",
          );
        } else {
          logger.info(`公開済みの記事 ${articles.length} 件を build-info.json の articles に記録します。`);
        }
      },
      "astro:build:done": async ({ dir, logger }) => {
        const info: BuildInfo = {
          commit: await headCommit(projectRoot),
          builtAt: new Date().toISOString(),
          articles,
        };
        if (info.commit === null) {
          logger.warn(
            "git rev-parse HEAD でコミットを取れなかったため、build-info.json の commit は null です（監視アプリは再配信の要否を判定できません）。",
          );
        }
        await writeFile(
          path.join(fileURLToPath(dir), BUILD_INFO_FILE),
          `${JSON.stringify(info, null, 2)}\n`,
          "utf8",
        );
        const markedCommit = process.env.BUILD_COMMIT_SHA?.trim();
        if (markedCommit) {
          if (!/^[0-9a-f]{40}$/.test(markedCommit)) {
            throw new Error("BUILD_COMMIT_SHA は 40 桁の小文字の 16 進数にしてください（_build.json に書くコミット）");
          }
          await writeFile(
            path.join(fileURLToPath(dir), BUILD_MARK_FILE),
            `${JSON.stringify({ commit: markedCommit, builtAt: info.builtAt }, null, 2)}\n`,
            "utf8",
          );
          logger.info(`${BUILD_MARK_FILE} を書きました（commit=${markedCommit.slice(0, 7)}）`);
        }
        logger.info(`${BUILD_INFO_FILE} を書きました（commit=${info.commit?.slice(0, 7) ?? "なし"}）`);
      },
    },
  };
}
