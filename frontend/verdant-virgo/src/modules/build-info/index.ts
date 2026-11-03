// build-info モジュール: ビルドの最後に dist/build-info.json（コミットとビルドの日時）を書く Astro インテグレーション。
// 目的は「配信中のサイトが、どのコミットから作られたか」を HTTPS で読めるようにすること。
// 監視アプリ（backend/control-plane の status/drift.ts）が、origin/main に公開サイトの変更が増えたのに
// 再配信していない状態を見つけるのに使う（docs/superpowers/specs/2026-11-03-setup-status-design.md の 5.3）。
// 公開される JSON なので、入れるのはコミットの SHA とビルドの日時だけ（秘密値・パス・ブランチ名は入れない）。
// コミットは、Astro のプロジェクトのルート（config.root。frontend/verdant-virgo）の `git rev-parse HEAD`。cwd には頼らない。取れなくてもビルドは止めず commit を null にする。
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AstroIntegration } from "astro";

const execFileAsync = promisify(execFile);

export const BUILD_INFO_FILE = "build-info.json";

export interface BuildInfo {
  /** ビルドしたときの HEAD の 40 桁のコミット。git を読めなかったときは null */
  readonly commit: string | null;
  /** ビルドの完了時刻（ISO 8601、UTC） */
  readonly builtAt: string;
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
  return {
    name: "comegin-build-info",
    hooks: {
      "astro:config:done": ({ config }) => {
        projectRoot = fileURLToPath(config.root);
      },
      "astro:build:done": async ({ dir, logger }) => {
        const info: BuildInfo = {
          commit: await headCommit(projectRoot),
          builtAt: new Date().toISOString(),
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
        logger.info(`${BUILD_INFO_FILE} を書きました（commit=${info.commit?.slice(0, 7) ?? "なし"}）`);
      },
    },
  };
}
