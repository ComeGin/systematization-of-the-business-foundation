// control-plane（管制ライブラリ）の設定。依存の導入 → ビルド（dist/）→ E-15 の置き場の用意。
// 出典: backend/control-plane/README.md（pnpm install・pnpm build、Node 24 の node:sqlite、E-15 は作業ツリーの外）、
//       src/config.ts の resolveDataDir（既定 ~/.local/share/comegin-control）、src/store/db.ts（置き場は 700・DB は 600）。
// next-js は link:../../backend/control-plane で dist/ を読むので、next-js より前にビルドしておく。
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const meta = { id: "control-plane", title: "管制ライブラリ（ビルドと E-15 の置き場）", targets: ["dev"], after: [] };

const dirOf = (ctx) => join(ctx.W, "backend/control-plane");
/** CONTROL_DATA_DIR（設定で上書き可。~ は展開する）。未設定なら README と同じ既定 */
const dataDirOf = (ctx) => {
  const raw = ctx.value("CONTROL_DATA_DIR");
  if (!raw) return join(homedir(), ".local/share/comegin-control");
  return raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
};

async function ensureTooling(ctx) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw new Error(`Node ${process.versions.node} は古い。control-plane は Node 24 以上が要る（node:sqlite を使う）`);
  let v;
  try {
    v = (await ctx.run("pnpm", ["--version"])).trim();
  } catch {
    throw new Error("pnpm が使えない。pnpm 11 以上を入れる（corepack enable && corepack prepare pnpm@latest --activate など）");
  }
  // pnpm-workspace.yaml の minimumReleaseAge などは pnpm 11 未満では効かない（黙って無効になる）
  if (Number(v.split(".")[0]) < 11) throw new Error(`pnpm ${v} は古い。pnpm 11 以上が要る（供給網対策の設定が pnpm 11 未満では効かない）`);
}

export async function check(ctx) {
  const dir = dirOf(ctx);
  const notes = [];
  let ok = true;
  const mark = (cond, good, bad) => {
    notes.push(cond ? good : bad);
    if (!cond) ok = false;
  };
  mark(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node}`, `Node ${process.versions.node} は古い（24 以上が要る）`);
  mark(existsSync(join(dir, "node_modules")), "依存は導入済み", "依存が未導入（pnpm install）");
  mark(existsSync(join(dir, "dist/index.js")) && existsSync(join(dir, "dist/index.d.ts")), "dist/ あり", "dist/ が無い（pnpm build）");
  const dataDir = dataDirOf(ctx);
  if (existsSync(dataDir)) mark((statSync(dataDir).mode & 0o077) === 0, `E-15 の置き場 ${dataDir} は 700 系`, `${dataDir} がほかのユーザーにも読める（chmod 700）`);
  else mark(false, "", `E-15 の置き場 ${dataDir} がまだ無い`);
  return { ok, notes };
}

export async function apply(ctx) {
  const dir = dirOf(ctx);
  await ensureTooling(ctx);

  ctx.log("pnpm install（lockfile 固定）");
  await ctx.run("pnpm", ["install", "--frozen-lockfile"], { cwd: dir });
  ctx.log("pnpm build（tsc → dist/。next-js が読む）");
  await ctx.run("pnpm", ["build"], { cwd: dir });
  if (!existsSync(join(dir, "dist/index.js"))) throw new Error("ビルドしたのに dist/index.js が無い");

  // E-15 は作業ツリーの外に置く（エージェントのファイル操作が届かない場所）。control-plane も起動時に 700 にするが、先に作っておく
  const dataDir = dataDirOf(ctx);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  ctx.log(`E-15 の置き場 ${dataDir} を用意した（700。e15.sqlite と auth.sqlite は監視アプリの初回起動で作られる）`);

  // builtin lighthouse は承認済み main のチェックアウトの node_modules を前提にする（README の「lighthouse の実行」）
  const main = ctx.value("CONTROL_MAIN_CHECKOUT");
  if (main && !existsSync(join(main, "MarketingDepartment/WebsiteOperations/frontend/verdant-virgo/node_modules"))) {
    ctx.warn(`${main} の frontend/verdant-virgo で pnpm install が済んでいない。builtin の lighthouse は dependencies not installed で skipped になる（定期実行を使うなら人が済ませる）`);
  }
}
