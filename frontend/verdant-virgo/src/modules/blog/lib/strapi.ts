// Strapi の Content API をビルド時に読む（I-09。DD-05 の 1 節）。strapi-mcp は使わない（1.1）。
// - 接続先は STRAPI_URL、認証は読み取り専用の API トークン STRAPI_API_TOKEN（どちらも PUBLIC_ を付けない）。
// - 1 リクエスト 20 秒。リトライは「届かない」2 回・「タイムアウト」1 回。それでも失敗したらビルドを失敗させる（1.2）。
// - 応答の形が想定と違えば、黙って進めずに例外にする（部分的に欠けたサイトを公開しない）。
// この層はサーバー（ビルド・dev サーバー）でだけ動く。ブラウザのコードから import しない。

const REQUEST_TIMEOUT_MS = 20_000;
const RETRIES = { unreachable: 2, timeout: 1 } as const;

export class StrapiBuildError extends Error {
  constructor(message: string) {
    super(`[blog] ${message}`);
    this.name = "StrapiBuildError";
  }
}

export function strapiOrigin(): string {
  const url = import.meta.env.STRAPI_URL?.trim();
  if (!url) {
    throw new StrapiBuildError(
      "STRAPI_URL が未設定です。環境変数ファイルに STRAPI_URL（開発は http://localhost:1337）を設定してください。",
    );
  }
  return new URL(url).origin;
}

function apiToken(): string {
  const token = import.meta.env.STRAPI_API_TOKEN?.trim();
  if (!token) {
    throw new StrapiBuildError(
      "STRAPI_API_TOKEN が未設定です。Strapi の管理画面（Settings > API Tokens）で読み取り専用のトークンを発行し、環境変数ファイルに設定してください。",
    );
  }
  return token;
}

async function fetchOnce(url: string, token: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/<path>。JSON の本文を返す */
export async function strapiGet<T>(pathAndQuery: string): Promise<T> {
  const origin = strapiOrigin();
  const token = apiToken();
  const url = `${origin}/api/${pathAndQuery}`;
  const attempts = { unreachable: 0, timeout: 0 };
  for (;;) {
    let response: Response;
    try {
      response = await fetchOnce(url, token);
    } catch (error) {
      const kind =
        error instanceof Error && error.name === "AbortError"
          ? "timeout"
          : "unreachable";
      if (attempts[kind] < RETRIES[kind]) {
        attempts[kind] += 1;
        continue;
      }
      throw new StrapiBuildError(
        kind === "timeout"
          ? `Strapi が ${REQUEST_TIMEOUT_MS / 1000} 秒以内に応答しませんでした（${origin}）。`
          : `Strapi に接続できませんでした（${origin}）。Strapi が起動しているかを確かめてください。`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new StrapiBuildError(
        `Strapi が ${response.status} を返しました。STRAPI_API_TOKEN が正しいか、article・category の find / findOne の権限があるかを確かめてください。`,
      );
    }
    if (!response.ok) {
      // Strapi のエラーの名前と文言（秘密値を含まない）を添えて、原因を追えるようにする
      const detail = await response
        .json()
        .then((data: { error?: { name?: string; message?: string } }) =>
          [data.error?.name, data.error?.message].filter(Boolean).join(": "),
        )
        .catch(() => "");
      throw new StrapiBuildError(
        `Strapi が ${response.status} を返しました（${origin}/api/${pathAndQuery.split("?")[0]}${detail ? `。${detail}` : ""}）。`,
      );
    }
    return (await response.json()) as T;
  }
}
