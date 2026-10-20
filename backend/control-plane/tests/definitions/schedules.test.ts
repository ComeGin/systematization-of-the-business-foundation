import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEDULES_DIR } from "../../src/constants/paths.js";
import { loadAgentDefinition } from "../../src/definitions/agent-def.js";
import { loadSchedules } from "../../src/definitions/schedules.js";
import { makeTempDir, putFile, repositoryRoot } from "../helpers/store.js";

let temp: ReturnType<typeof makeTempDir>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  temp = makeTempDir();
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  temp.cleanup();
});

function putSchedule(file: string, yaml: string): void {
  putFile(temp.dir, join(SCHEDULES_DIR, file), yaml);
}

const builtin = (id: string, extra = "") => `id: ${id}\ncron: "0 8 * * *"\nkind: builtin\nbuiltin: heartbeat\n${extra}`;
const agent = (id: string, extra = "") =>
  `id: ${id}\ncron: "0 6 * * *"\nkind: agent\nagent: seo-auditor\nprompt: "観測する"\n${extra}`;

describe("loadSchedules", () => {
  describe("正常系", () => {
    it("空入力: 定義のディレクトリが無ければ空", async () => {
      expect(await loadSchedules(temp.dir)).toEqual({ jobs: [], errors: [] });
    });

    it("空入力: 定義のディレクトリが空なら空", async () => {
      mkdirSync(join(temp.dir, SCHEDULES_DIR), { recursive: true });
      expect(await loadSchedules(temp.dir)).toEqual({ jobs: [], errors: [] });
    });

    it("既定値を補い（enabled は false、timeout_sec は 900）、ファイル名順に返す", async () => {
      putSchedule("b-job.yaml", builtin("b-job"));
      putSchedule("a-job.yaml", agent("a-job", "max_turns: 20\nafter: [b-job]\n"));
      const { jobs, errors } = await loadSchedules(temp.dir);
      expect(errors).toEqual([]);
      expect(jobs).toEqual([
        {
          id: "a-job",
          description: "",
          enabled: false,
          cron: "0 6 * * *",
          kind: "agent",
          agent: "seo-auditor",
          builtin: null,
          after: ["b-job"],
          timeoutSec: 900,
          maxTurns: 20,
          prompt: "観測する",
        },
        {
          id: "b-job",
          description: "",
          enabled: false,
          cron: "0 8 * * *",
          kind: "builtin",
          agent: null,
          builtin: "heartbeat",
          after: [],
          timeoutSec: 900,
          maxTurns: null,
          prompt: null,
        },
      ]);
    });

    it.each(["heartbeat", "i13-file", "miswrite-check", "silence-check", "lighthouse", "a11y", "published-article-check", "runlog-flush", "n8n-export"])(
      "builtin: %s を受け付ける",
      async (name) => {
        putSchedule("job.yaml", `id: job\ncron: "0 8 * * *"\nkind: builtin\nbuiltin: ${name}\n`);
        const { jobs, errors } = await loadSchedules(temp.dir);
        expect(errors).toEqual([]);
        expect(jobs[0]).toMatchObject({ kind: "builtin", builtin: name });
      },
    );

    it("n8n-export の定義は enabled・timeout_sec・after を指定どおりに読む", async () => {
      putSchedule("n8n-export.yaml", 'id: n8n-export\ncron: "30 3 * * *"\nkind: builtin\nbuiltin: n8n-export\nenabled: true\ntimeout_sec: 600\n');
      const { jobs } = await loadSchedules(temp.dir);
      expect(jobs).toEqual([
        expect.objectContaining({ id: "n8n-export", enabled: true, builtin: "n8n-export", timeoutSec: 600, after: [], agent: null, prompt: null }),
      ]);
    });

    it(".yaml 以外のファイルは読まない", async () => {
      putSchedule("x.yml", builtin("x"));
      putSchedule("README.md", "# memo");
      expect((await loadSchedules(temp.dir)).jobs).toEqual([]);
    });

    it("kind=builtin では agent と prompt を書いてあっても捨てる", async () => {
      putSchedule("b.yaml", builtin("b", "agent: lead-ops\nprompt: 何か\n"));
      const [job] = (await loadSchedules(temp.dir)).jobs;
      expect(job).toMatchObject({ kind: "builtin", agent: null, prompt: null });
    });

    it("kind=agent では builtin を書いてあっても捨てる", async () => {
      putSchedule("a.yaml", agent("a", "builtin: heartbeat\n"));
      const [job] = (await loadSchedules(temp.dir)).jobs;
      expect(job).toMatchObject({ kind: "agent", builtin: null });
    });
  });

  describe("異常系", () => {
    it("空入力: 空の YAML ファイルは errors に入れ、jobs に入れない", async () => {
      putSchedule("empty.yaml", "");
      const { jobs, errors } = await loadSchedules(temp.dir);
      expect(jobs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("empty.yaml");
    });

    it.each([
      ["kind=agent で agent が無い", "id: a\ncron: '0 6 * * *'\nkind: agent\nprompt: x\n", /agent: kind=agent では必須です/],
      ["kind=agent で prompt が空白だけ", "id: a\ncron: '0 6 * * *'\nkind: agent\nagent: x\nprompt: '  '\n", /prompt: kind=agent では必須です/],
      ["kind=builtin で builtin が無い", "id: a\ncron: '0 6 * * *'\nkind: builtin\n", /builtin: kind=builtin では必須です/],
      ["知らない builtin", "id: a\ncron: '0 6 * * *'\nkind: builtin\nbuiltin: rm-rf\n", /^builtin:/],
      ["廃止した Umami 向けの builtin 名", "id: a\ncron: '0 6 * * *'\nkind: builtin\nbuiltin: umami-export\n", /^builtin:/],
      ["6 フィールドの cron（秒付き）", "id: a\ncron: '0 0 6 * * *'\nkind: builtin\nbuiltin: heartbeat\n", /cron: 5 フィールド/],
      ["範囲外の cron", "id: a\ncron: '61 * * * *'\nkind: builtin\nbuiltin: heartbeat\n", /cron: 5 フィールド/],
      ["空文字の cron", "id: a\ncron: ''\nkind: builtin\nbuiltin: heartbeat\n", /cron: 5 フィールド/],
      ["kebab-case でない id", "id: A_job\ncron: '0 6 * * *'\nkind: builtin\nbuiltin: heartbeat\n", /id: kebab-case/],
      ["負の timeout_sec", "id: a\ncron: '0 6 * * *'\nkind: builtin\nbuiltin: heartbeat\ntimeout_sec: -1\n", /timeout_sec/],
      ["文字列の enabled", "id: a\ncron: '0 6 * * *'\nkind: builtin\nbuiltin: heartbeat\nenabled: 'yes'\n", /enabled/],
    ])("入力: %s は errors に入れ、jobs に入れない", async (_label, yaml, reason) => {
      putSchedule("a.yaml", yaml);
      const { jobs, errors } = await loadSchedules(temp.dir);
      expect(jobs).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe("a.yaml");
      expect(errors[0]?.reason).toMatch(reason);
    });

    it("入力: id がファイル名と違えば errors に入れる", async () => {
      putSchedule("one.yaml", builtin("two"));
      expect((await loadSchedules(temp.dir)).errors).toEqual([{ file: "one.yaml", reason: "id がファイル名と一致しません" }]);
    });

    it("入力: YAML として読めないファイルがあっても、他の定義は読み込む", async () => {
      putSchedule("broken.yaml", "id: [unclosed\n");
      putSchedule("ok.yaml", builtin("ok"));
      const { jobs, errors } = await loadSchedules(temp.dir);
      expect(jobs.map((job) => job.id)).toEqual(["ok"]);
      expect(errors.map((error) => error.file)).toEqual(["broken.yaml"]);
    });

    it("入力: 読めなかった定義と、定義に無い after を stderr に WARN で出す（ジョブ自体は読み込む）", async () => {
      putSchedule("a.yaml", builtin("a", "after: [ghost]\n"));
      putSchedule("bad.yaml", "id: bad\n");
      const { jobs } = await loadSchedules(temp.dir);
      expect(jobs.map((job) => job.id)).toEqual(["a"]);
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => /WARN schedules a: after の ghost が定義に無い/.test(line))).toBe(true);
      expect(lines.some((line) => /WARN schedules bad\.yaml を読み込めない/.test(line))).toBe(true);
    });
  });
});

describe("実在の定期実行の定義（ops/schedules）", () => {
  const root = repositoryRoot();

  describe("正常系", () => {
    it.skipIf(!root)("すべて検証を通り、kind=agent のエージェント定義が実在する", async () => {
      const files = readdirSync(join(root!, SCHEDULES_DIR)).filter((file) => file.endsWith(".yaml"));
      const { jobs, errors } = await loadSchedules(root!);
      expect(errors).toEqual([]);
      expect(jobs).toHaveLength(files.length);
      const ids = new Set(jobs.map((job) => job.id));
      for (const job of jobs) {
        for (const dependency of job.after) expect({ job: job.id, dependency, known: ids.has(dependency) }).toMatchObject({ known: true });
        if (job.agent) await expect(loadAgentDefinition(root!, job.agent)).resolves.toMatchObject({ name: job.agent });
      }
    });
  });
});
