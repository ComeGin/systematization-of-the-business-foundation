// ビルドの失敗条件を守る Astro インテグレーション（DD-05 の 1.2・1.5.1・1.5.4、ADR-11）。astro.config.mjs に登録する。
// 1. image.remotePatterns に Strapi（と本番のメディアの S3）を許可する。許可が無いと <Image> は黙って元の URL を出す（1.5.1）
// 2. 配信用のビルド（BUILD_TARGET=production）で STRAPI_URL が localhost を指していたら停止する（1.2）
// 3. ビルドの最後に dist/ の HTML・CSS・JS・XML を走査し、Strapi・S3 の URL、/uploads/、署名付き URL の
//    署名が残っていたらビルドを失敗させる（1.5.4）。pnpm build と pnpm lh のどちらでも走る。
// 環境変数は astro.config.mjs と同じく Vite の loadEnv で読む（設定ファイルでは自動で読み込まれないため）。
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { loadEnv } from "vite";

type RemotePattern = {
  protocol?: string;
  hostname?: string;
  port?: string;
  pathname?: string;
};

const SCANNED_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".xml"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full) : Promise.resolve([full]);
    }),
  );
  return files.flat();
}

/** 署名付き URL が漏れていたら、署名の部分を伏せて出す（DD-05 の 1.5.4） */
const maskSignature = (text: string) =>
  text.replace(
    /(X-Amz-(?:Signature|Credential|Security-Token)=)[^&"'\s)]+/g,
    "$1***",
  );

export function comeginStrapiGuard(): AstroIntegration {
  let needles: string[] = [];

  return {
    name: "comegin-strapi-guard",
    hooks: {
      "astro:config:setup": ({ command, updateConfig }) => {
        const env = loadEnv(
          process.env.NODE_ENV ?? "development",
          process.cwd(),
          "",
        );
        const strapiUrl = env.STRAPI_URL?.trim();
        const patterns: RemotePattern[] = [];
        needles = ["/uploads/", "X-Amz-Signature"];

        if (strapiUrl) {
          const url = new URL(strapiUrl);
          if (
            command === "build" &&
            env.BUILD_TARGET === "production" &&
            LOCAL_HOSTS.has(url.hostname)
          ) {
            throw new Error(
              `配信用のビルド（BUILD_TARGET=production）で STRAPI_URL が ${url.origin} を指しています。開発の Strapi の試験記事を公開しないため停止します（DD-05 の 1.2）。`,
            );
          }
          patterns.push({
            protocol: url.protocol.replace(":", ""),
            hostname: url.hostname,
            ...(url.port ? { port: url.port } : {}),
          });
          needles.push(url.origin, `//${url.host}`);
        }

        // 本番のメディアの S3（仮想ホスト形式とパス形式の両方。署名のクエリは照合しない）
        const bucket = env.UPLOAD_S3_BUCKET?.trim();
        const region = env.UPLOAD_S3_REGION?.trim();
        if (bucket && region) {
          patterns.push(
            {
              protocol: "https",
              hostname: `${bucket}.s3.${region}.amazonaws.com`,
            },
            {
              protocol: "https",
              hostname: `s3.${region}.amazonaws.com`,
              pathname: `/${bucket}/**`,
            },
          );
          needles.push(
            `${bucket}.s3.${region}.amazonaws.com`,
            `s3.${region}.amazonaws.com/${bucket}`,
            `${bucket}.s3.amazonaws.com`,
          );
        }

        updateConfig({ image: { remotePatterns: patterns } });
      },

      "astro:build:done": async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const findings: string[] = [];
        for (const file of await listFiles(root)) {
          if (!SCANNED_EXTENSIONS.has(path.extname(file))) continue;
          const lines = (await readFile(file, "utf8")).split("\n");
          lines.forEach((line, index) => {
            for (const needle of needles) {
              const at = line.indexOf(needle);
              if (at < 0) continue;
              const excerpt = line.slice(
                Math.max(0, at - 60),
                at + needle.length + 60,
              );
              findings.push(
                `${path.relative(root, file)}:${index + 1}  ${needle}  …${maskSignature(excerpt)}…`,
              );
            }
          });
        }
        if (findings.length > 0) {
          throw new Error(
            `dist/ に Strapi・S3 の URL が残っています（${findings.length} 件）。公開後の表示が Strapi に依存するため、ビルドを失敗させます（DD-05 の 1.5.4）。\n${findings.join("\n")}`,
          );
        }
        logger.info(
          "dist/ に Strapi・S3 の URL が残っていないことを確かめました。",
        );
      },
    },
  };
}
