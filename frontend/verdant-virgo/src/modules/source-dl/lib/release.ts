// 「ソースコードを無料 DL」でダウンロードさせる zip を、公開リポジトリの最新リリースから決める（2026-11-21 にユーザーが決めた。
// それまでは nav.ts の SOURCE_ZIP_URL にタグ test-v0.1 のアーカイブを決め打ちしていた）。
//
// - ビルドのとき（Astro のページの frontmatter）に GitHub の REST API の「最新のリリース」を 1 回だけ読む（同じプロセスでは結果を使い回す）。
//   最新のリリースは、下書きとプレリリースを除いた、いちばん新しいリリース（GitHub の仕様）
// - リリースの Assets に、アップロードした .zip があればそれ（browser_download_url）。無ければ、そのタグの「Source code (zip)」
//   （archive/refs/tags/<タグ>.zip）。どちらも GitHub が添付ファイルとして返すので、別のタブでダウンロードが始まる（redirect.ts）
// - 読めない（GitHub の障害・回数の制限・リリースが無い）ときは、ビルドを止めず、リリースのページ（releases/latest）にする。
//   押すと別のタブでリリースのページが開き、訪問者がそこで zip を選ぶ。警告をビルドのログに出す
// - 静的なサイトなので、新しいリリースを出しても、次のビルド・配信までは前のリンクのまま
//
// クライアントの JS からは import しない（fetch をブラウザに持ち込まない）。値は SourceDlRedirect の data 属性で渡す。
// 出典: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
//       https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives
import { SOURCE_REPO_URL } from "@/modules/site-content/nav";

const API_TIMEOUT_MS = 8_000;

export interface ReleaseAsset {
  readonly name: string;
  readonly content_type?: string;
  readonly browser_download_url: string;
}

export interface LatestRelease {
  readonly tag_name: string;
  readonly assets?: readonly ReleaseAsset[];
}

/** 公開リポジトリの URL（https://github.com/<owner>/<repo>）から owner と repo を取る */
function repoPath(repoUrl: string): { owner: string; repo: string } {
  const url = new URL(repoUrl);
  const [owner, repo] = url.pathname.replace(/^\/|\/$/g, "").split("/");
  if (url.hostname !== "github.com" || !owner || !repo) {
    throw new Error(
      `SOURCE_REPO_URL が GitHub のリポジトリの URL ではありません: ${repoUrl}`,
    );
  }
  return { owner, repo };
}

function requireRepoUrl(): string {
  if (!SOURCE_REPO_URL)
    throw new Error(
      "SOURCE_REPO_URL が無いため、ダウンロードの zip を決められません（site-content/nav.ts）",
    );
  return SOURCE_REPO_URL.replace(/\/+$/, "");
}

/** 最新のリリースが読めないときのリンク（リリースのページ） */
export function fallbackUrl(repoUrl: string = requireRepoUrl()): string {
  return `${repoUrl}/releases/latest`;
}

/** 最新のリリースから zip の URL を決める（アップロードした .zip ＞ そのタグの Source code の zip） */
export function zipUrlFromRelease(
  release: LatestRelease,
  repoUrl: string = requireRepoUrl(),
): string {
  const uploaded = (release.assets ?? []).find(
    (asset) =>
      asset.name.toLowerCase().endsWith(".zip") ||
      asset.content_type === "application/zip",
  );
  if (uploaded) return uploaded.browser_download_url;
  const tag = release.tag_name.split("/").map(encodeURIComponent).join("/");
  return `${repoUrl}/archive/refs/tags/${tag}.zip`;
}

/** ダウンロードのリンクとして正しい形（E2E が href と window.open の引数を確かめるのに使う） */
export function isSourceZipUrl(
  value: string,
  repoUrl: string = requireRepoUrl(),
): boolean {
  if (!value.startsWith(`${repoUrl}/`)) return false;
  const rest = value.slice(repoUrl.length + 1);
  return (
    /^archive\/refs\/tags\/.+\.zip$/.test(rest) ||
    /^releases\/download\/[^/]+\/[^/]+$/.test(rest) ||
    rest === "releases/latest"
  );
}

let resolved: Promise<string> | null = null;

/** 最新のリリースの zip の URL（ビルドのプロセスで 1 回だけ GitHub を読む） */
export function resolveSourceZipUrl(): Promise<string> {
  resolved ??= (async () => {
    const repoUrl = requireRepoUrl();
    const { owner, repo } = repoPath(repoUrl);
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "comegin-site-build",
          },
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = zipUrlFromRelease(
        (await res.json()) as LatestRelease,
        repoUrl,
      );
      console.info(`[source-dl] ダウンロードの zip: ${url}`);
      return url;
    } catch (error) {
      const fallback = fallbackUrl(repoUrl);
      console.warn(
        `[source-dl] GitHub の最新のリリースを読めませんでした（${error instanceof Error ? error.message : String(error)}）。` +
          `リリースのページ ${fallback} をリンクにします`,
      );
      return fallback;
    }
  })();
  return resolved;
}
