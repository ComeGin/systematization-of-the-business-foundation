import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDocSection } from "../../src/status/docs.js";
import { makeTempDir, putFile } from "../helpers/store.js";

let temp: ReturnType<typeof makeTempDir>;

beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => {
  temp.cleanup();
});

const FILE = "cloud/README.md";
const ALLOWED = [FILE, "onprem/README.md"];

const DOC = [
  "# cloud",
  "",
  "前置き",
  "",
  "## 4. 手順",
  "",
  "### 4.1 global を作る",
  "global の説明",
  "",
  "### 4.10 十番目",
  "十番目の説明",
  "",
  "### 4.14 SES を設定する",
  "SES の説明",
  "",
  "```bash",
  "# これはコメントで見出しではない",
  "### これも見出しではない",
  "```",
  "",
  "コードブロックの後の続き",
  "",
  "#### 4.14.1 細目",
  "細目の説明",
  "",
  "### 4.15 次の節",
  "次の説明",
  "",
  "## 5. 別の章",
  "別の章の説明",
].join("\n");

async function read(heading: string, file = FILE, allowed: string[] = ALLOWED) {
  return readDocSection(temp.dir, file, heading, allowed);
}

describe("readDocSection", () => {
  describe("正常系", () => {
    it("入力: heading '4.14' は '### 4.14 …' の行から、次の同じ深さの見出し '### 4.15' の前まで", async () => {
      putFile(temp.dir, FILE, DOC);
      const section = await read("4.14");
      expect(section).not.toBeNull();
      expect(section!.file).toBe(FILE);
      expect(section!.heading).toBe("4.14 SES を設定する");
      expect(section!.markdown.startsWith("### 4.14 SES を設定する\nSES の説明")).toBe(true);
      expect(section!.markdown).toContain("#### 4.14.1 細目\n細目の説明");
      expect(section!.markdown).not.toContain("4.15");
      expect(section!.markdown).not.toContain("別の章");
    });

    it("入力: コードブロックの中の '# ' や '### ' で節が切れない", async () => {
      putFile(temp.dir, FILE, DOC);
      const section = await read("4.14");
      expect(section!.markdown).toContain("# これはコメントで見出しではない");
      expect(section!.markdown).toContain("### これも見出しではない");
      expect(section!.markdown).toContain("コードブロックの後の続き");
    });

    it("入力: 入れ子の節（深い見出し）は含み、浅い見出し '## 5.' の前で終わる", async () => {
      putFile(temp.dir, FILE, DOC);
      const section = await read("4. 手順");
      expect(section!.markdown).toContain("### 4.1 global を作る");
      expect(section!.markdown).toContain("#### 4.14.1 細目");
      expect(section!.markdown).toContain("次の説明");
      expect(section!.markdown).not.toContain("別の章");
    });

    it("入力: 末尾の節はファイルの終わりまで（末尾の空行は落とす）", async () => {
      putFile(temp.dir, FILE, `${DOC}\n\n\n`);
      const section = await read("5.");
      expect(section!.markdown).toBe("## 5. 別の章\n別の章の説明");
    });

    it("入力: 末尾が数字の heading は、後ろに数字が続く見出しに当たらない（'4.1' は '4.10' ではなく '4.1 …'）", async () => {
      putFile(temp.dir, FILE, DOC);
      const section = await read("4.1");
      expect(section!.heading).toBe("4.1 global を作る");
      expect(section!.markdown).toContain("global の説明");
      expect(section!.markdown).not.toContain("十番目");
    });

    it("入力: '4.10' は '4.1 …' ではなく '4.10 …' に当たる", async () => {
      putFile(temp.dir, FILE, DOC);
      expect((await read("4.10"))!.heading).toBe("4.10 十番目");
    });

    it("入力: '4.14' は '4.14.1 …'（.数字 が続く見出し）に当たらず、1 つに決まる", async () => {
      putFile(temp.dir, FILE, DOC);
      expect((await read("4.14"))!.heading).toBe("4.14 SES を設定する");
    });

    it("入力: 末尾が数字でない heading は先頭一致のまま（'4. 手順'）", async () => {
      putFile(temp.dir, FILE, DOC);
      expect((await read("4. 手"))!.heading).toBe("4. 手順");
    });

    it("入力: CRLF の手順書でも見出しを引ける", async () => {
      putFile(temp.dir, FILE, DOC.replace(/\n/g, "\r\n"));
      const section = await read("4.14");
      expect(section!.heading).toBe("4.14 SES を設定する");
      expect(section!.markdown).not.toContain("4.15");
    });

    it("入力: ~~~ のコードブロックの中も見出しとみなさない", async () => {
      putFile(temp.dir, FILE, ["## A", "本文", "~~~", "## B", "~~~", "続き", "## C"].join("\n"));
      expect((await read("A"))!.markdown).toBe("## A\n本文\n~~~\n## B\n~~~\n続き");
      expect(await read("B")).toBeNull();
    });
  });

  describe("異常系", () => {
    it.each(["../x.md", "../../etc/passwd", "cloud/../../x.md", "/etc/passwd", "cloud//README.md", "./cloud/README.md", "cloud\\README.md", ""])(
      "入力: file が '%s'（.. ・絶対パス・不正な形）なら、許可リストにあっても null",
      async (file) => {
        putFile(temp.dir, FILE, DOC);
        expect(await read("4.14", file, [file, FILE])).toBeNull();
      },
    );

    it("入力: カタログの docs に無いファイルは、存在しても null", async () => {
      putFile(temp.dir, "setup/secret.md", "## 4.14 x\n本文");
      expect(await read("4.14", "setup/secret.md")).toBeNull();
    });

    it("空入力: 許可リストが空なら null", async () => {
      putFile(temp.dir, FILE, DOC);
      expect(await read("4.14", FILE, [])).toBeNull();
    });

    it("空入力: heading が空・空白だけなら null（全部に先頭一致してしまうため）", async () => {
      putFile(temp.dir, FILE, DOC);
      expect(await read("")).toBeNull();
      expect(await read("  ")).toBeNull();
    });

    it("入力: ファイルが無ければ null（例外にしない）", async () => {
      expect(await read("4.14")).toBeNull();
    });

    it("入力: 見出しが無ければ null", async () => {
      putFile(temp.dir, FILE, DOC);
      expect(await read("9.9")).toBeNull();
    });

    it("入力: コードブロックの中にしか無い見出しは null", async () => {
      putFile(temp.dir, FILE, DOC);
      expect(await read("これも見出しではない")).toBeNull();
    });

    it("入力: 先頭一致する見出しが 2 つ以上ある（どちらか決められない）なら null", async () => {
      putFile(temp.dir, FILE, "## 4. 手順 A\na\n## 4. 手順 B\nb\n");
      expect(await read("4. 手順")).toBeNull();
    });

    it("入力: チェックアウトの外を指すシンボリックリンクは、許可リストにあっても null", async () => {
      const outside = makeTempDir("cp-outside-");
      try {
        putFile(outside.dir, "leak.md", "## 4.14 漏れ\n本文");
        mkdirSync(join(temp.dir, "cloud"), { recursive: true });
        symlinkSync(join(outside.dir, "leak.md"), join(temp.dir, FILE));
        expect(await read("4.14")).toBeNull();
      } finally {
        outside.cleanup();
      }
    });

    it("入力: mainCheckout が存在しなくても null（例外にしない）", async () => {
      expect(await readDocSection(join(temp.dir, "none"), FILE, "4.14", ALLOWED)).toBeNull();
    });
  });
});
