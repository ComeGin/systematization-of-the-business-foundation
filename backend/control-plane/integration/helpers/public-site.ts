// 偽の公開サイト（本番の S3 ＋ CloudFront の代わり）。テストの中で 127.0.0.1 の空きポートに立て、SITE_URL にする。
// 公開サイトはクラウド（AWS）にあり、開発スタックに無いので差し替える。
//
// 配信（人が画面の手順で打つ `aws s3 sync` 2 本と `aws cloudfront create-invalidation`）は deploy(distPath) で代える:
// 配信する dist を丸ごと置き換える（--delete と同じく、無くなったファイルは消える）。配信の前は何も置いていない（どの URL も 404）。
// 静的なファイルを返すだけ（/blog/<slug>/ は blog/<slug>/index.html、/_build.json はビルドの印）。クエリは無視する（CloudFront と同じ）。
// fail() で、配信の有無に関わらず決まった状態（503 など）を返せる（公開サイトの障害）。
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";

const CONTENT_TYPE: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json" };

export class PublicSite {
  readonly requests: string[] = [];
  /** 配信した回数（deploy を呼んだ回数） */
  deployments = 0;
  url = "";
  readonly #root = mkdtempSync(join(tmpdir(), "cp-it-site-"));
  #fault: number | null = null;
  #server!: Server;

  static async start(): Promise<PublicSite> {
    const site = new PublicSite();
    site.#server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://site").pathname);
      site.requests.push(pathname);
      if (site.#fault !== null) {
        res.writeHead(site.#fault).end("fake failure");
        return;
      }
      const file = site.#resolve(pathname);
      if (!file) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end("<h1>404</h1>");
        return;
      }
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": CONTENT_TYPE[ext] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
    });
    await new Promise<void>((resolve) => site.#server.listen(0, "127.0.0.1", resolve));
    site.url = `http://127.0.0.1:${(site.#server.address() as AddressInfo).port}`;
    return site;
  }

  /** 配信先の中のファイル。ディレクトリなら index.html。外に出るパス・無いものは null */
  #resolve(pathname: string): string | null {
    const live = join(this.#root, "live");
    const target = normalize(join(live, pathname));
    if (target !== live && !target.startsWith(live + sep)) return null;
    const file = pathname.endsWith("/") ? join(target, "index.html") : target;
    return existsSync(file) && statSync(file).isFile() ? file : null;
  }

  /** 配信（aws s3 sync --delete と CloudFront の無効化の代わり）。distPath は deploy の項目の preview.distPath */
  deploy(distPath: string): void {
    const live = join(this.#root, "live");
    rmSync(live, { recursive: true, force: true });
    cpSync(distPath, live, { recursive: true });
    this.deployments++;
  }

  /** 今の配信のビルドの印（無ければ null） */
  buildCommit(): string | null {
    const file = join(this.#root, "live", "_build.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { commit?: string }).commit ?? null : null;
  }

  /** どの要求にも status を返す（null で戻す） */
  fail(status: number | null): void {
    this.#fault = status;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    rmSync(this.#root, { recursive: true, force: true });
  }
}
