// Agent SDK（@anthropic-ai/claude-agent-sdk）の query() の差し替えで返すメッセージ。
// control-plane の runner/agent.ts が読む項目だけを持つ（init の検査・result の subtype・本文・費用）。
// 型は control-plane の依存にしか無いので、ここでは形だけを書く。
export type FakeMessage = Record<string, unknown>;

/** 起動時の検査（権限モード dontAsk・ANTHROPIC_API_KEY での認証・Bash が無い・MCP の接続）を通る init */
export function initMessage(overrides: FakeMessage = {}): FakeMessage {
  return {
    type: "system",
    subtype: "init",
    mcp_servers: [],
    permissionMode: "dontAsk",
    apiKeySource: "ANTHROPIC_API_KEY",
    tools: ["Read", "Grep", "Glob"],
    ...overrides,
  };
}

export function resultMessage(text: string, overrides: FakeMessage = {}): FakeMessage {
  return { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0.0123, ...overrides };
}

/** query() の引数（プロンプトと Options）。テストで中身を確かめる */
export interface QueryArgs {
  prompt: string;
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    settingSources: unknown[];
    permissionMode: string;
    tools: string[];
    allowedTools: string[];
    disallowedTools: string[];
    mcpServers: Record<string, unknown>;
    persistSession: boolean;
    maxTurns: number;
    abortController: AbortController;
  };
}

/** メッセージを順に流す query() の実装。gate を渡すと、それが解けるまで結果を返さない（実行中のまま） */
export function scripted(messages: FakeMessage[], gate?: Promise<void>) {
  return (): AsyncGenerator<FakeMessage> =>
    (async function* () {
      for (const [index, message] of messages.entries()) {
        if (gate && index === messages.length - 1) await gate;
        yield message;
      }
    })();
}

/** 最初のメッセージの前に例外を投げる query()（API に届かない・SDK の子プロセスが起動できないなど） */
export function throwing(error: Error) {
  return (): AsyncGenerator<FakeMessage> =>
    (async function* () {
      throw error;
    })();
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
