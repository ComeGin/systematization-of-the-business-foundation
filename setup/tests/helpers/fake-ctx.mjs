// モジュールの check に渡す偽の ctx。実際の状態ファイル・AWS・HTTP・子プロセスには触れない。
// 本物の createContext と同じく、--check のときは state.set が「check の中で状態を書こうとした」を投げる。
import { readEnvFile } from "../../lib/core.mjs";

export function fakeCtx({ conf = {}, stateValues = {}, overrides = {} } = {}) {
  const state = {
    get: (key) => stateValues[key],
    has: (key) => stateValues[key] !== undefined && stateValues[key] !== "",
    set: (key) => {
      throw new Error(`check の中で状態を書こうとした: ${key}`);
    },
    isSecret: () => false,
  };
  const ctx = {
    target: "prod",
    phase: null,
    siteRouted: false,
    checkOnly: true,
    conf,
    state,
    W: "/nonexistent/W",
    REPO: "/nonexistent/REPO",
    WORKTREE: "/nonexistent/WORKTREE",
    CONFIG_DIR: "/nonexistent/config",
    log: () => {},
    warn: () => {},
    http: async () => {
      throw Object.assign(new Error("偽の http が呼ばれた"), { status: 0 });
    },
    run: async () => {
      throw new Error("偽の run が呼ばれた");
    },
    commandExists: async () => false,
    waitForHttp: async () => false,
    readEnvFile,
    writeEnvFile: () => {
      throw new Error("check の中で環境変数ファイルを書こうとした");
    },
    value: (key) => conf[key] || stateValues[key],
    require: (key) => {
      const v = conf[key] || stateValues[key];
      if (!v) throw new Error(`${key} が無い`);
      return v;
    },
    ...overrides,
  };
  return ctx;
}

/** items を key で引く */
export const itemsByKey = (result) => Object.fromEntries((result.items ?? []).map((i) => [i.key, i]));
