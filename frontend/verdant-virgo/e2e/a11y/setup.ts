// pnpm a11y の globalSetup。前回のページごとの結果を消し、実行の開始時刻を残す
// （summary.json の measured_at になる。E-12 の measured_at と試験結果の表明に使う）。
import fs from "node:fs";
import { PAGES_DIR, RUN_FILE } from "./routes";

export default function globalSetup() {
  fs.rmSync(PAGES_DIR, { recursive: true, force: true });
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  fs.writeFileSync(
    RUN_FILE,
    JSON.stringify({ started_at: new Date().toISOString() }),
  );
}
