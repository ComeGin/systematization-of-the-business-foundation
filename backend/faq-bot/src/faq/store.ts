import { buildIndex, type IndexedEntry } from "../matcher/index.js";
import { FaqDocumentSchema, type FaqItem } from "./schema.js";

export interface FaqSnapshot {
  readonly items: readonly FaqItem[];
  readonly index: readonly IndexedEntry<FaqItem>[];
  readonly byId: ReadonlyMap<string, FaqItem>;
  readonly loadedAt: number;
}

/** 照合の索引は「context ＋ 質問」で作る（同じ質問が複数のページにあるため。仕様 5 節。context を前に置くと、質問の末尾の定型句を削れる） */
export function buildSnapshot(items: readonly FaqItem[], loadedAt: number): FaqSnapshot {
  return {
    items,
    index: buildIndex(items, (item) => `${item.context ?? ""}${item.question}`),
    byId: new Map(items.map((item) => [item.id, item])),
    loadedAt,
  };
}

export class FaqUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaqUnavailableError";
  }
}

export interface FaqSource {
  current(): Promise<FaqSnapshot>;
}

export interface FaqStoreOptions {
  url: string;
  refreshMs: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  warn?: (message: string) => void;
}

/** faq.json をメモリに持つ。古くなったら取り直し、失敗したら直前の索引を使い続ける（仕様 8 節） */
export class FaqStore implements FaqSource {
  #snapshot: FaqSnapshot | null = null;
  #inflight: Promise<void> | null = null;

  constructor(private readonly options: FaqStoreOptions) {}

  async current(): Promise<FaqSnapshot> {
    const now = this.#now();
    if (!this.#snapshot || now - this.#snapshot.loadedAt >= this.options.refreshMs) {
      this.#inflight ??= this.#load().finally(() => {
        this.#inflight = null;
      });
      await this.#inflight;
    }
    if (!this.#snapshot) throw new FaqUnavailableError("faq.json をまだ一度も取得できていない");
    return this.#snapshot;
  }

  #now(): number {
    return (this.options.now ?? Date.now)();
  }

  async #load(): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(this.options.url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new Error("JSON として読めない");
      }
      const parsed = FaqDocumentSchema.safeParse(body);
      if (!parsed.success) throw new Error(`形式が違う（${parsed.error.issues[0]?.path.join(".") || "root"}）`);
      this.#snapshot = buildSnapshot(parsed.data.items, this.#now());
    } catch (error) {
      (this.options.warn ?? ((message: string) => console.error(message)))(
        `[faq] faq.json を更新できない（${this.#snapshot ? "直前の索引を使う" : "索引が無い"}）: ${(error as Error).message}`,
      );
      // 直前の索引があれば、次の更新間隔まで取り直さない（毎回の要求で取りに行かない）
      if (this.#snapshot) this.#snapshot = { ...this.#snapshot, loadedAt: this.#now() };
    }
  }
}
