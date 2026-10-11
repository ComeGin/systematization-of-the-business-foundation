import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// posthog-node は偽物に差し替える（実際の PostHog には送らない）。作られたクライアントは instances に積み、
// テストごとに beforeEach で空にする
const { instances, FakePostHog } = vi.hoisted(() => {
  const instances: Array<{
    token: string;
    options: Record<string, unknown>;
    capture: ReturnType<typeof vi.fn>;
    captureException: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  }> = [];

  class FakePostHog {
    capture = vi.fn();
    captureException = vi.fn();
    flush = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});

    constructor(
      public token: string,
      public options: Record<string, unknown>
    ) {
      instances.push(this);
    }
  }

  return { instances, FakePostHog };
});

vi.mock('posthog-node', () => ({ PostHog: FakePostHog }));

type PostHogModule = typeof import('../src/posthog');

const loadModule = async (env: Record<string, string | undefined>): Promise<PostHogModule> => {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  return import('../src/posthog');
};

const configured = {
  NODE_ENV: 'development',
  POSTHOG_PROJECT_TOKEN: 'phc_test_token',
  POSTHOG_HOST: 'https://posthog.example.test',
};

const unconfiguredProduction = {
  NODE_ENV: 'production',
  POSTHOG_PROJECT_TOKEN: undefined,
  POSTHOG_HOST: undefined,
};

// console.error に渡されたものを 1 つの文字列にする（秘密値が混ざっていないかを見るため）
const loggedText = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')).join('\n');

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('posthog: 環境変数の検証', () => {
  describe('正常系', () => {
    it('空入力: 本番では未設定でも例外を投げず、クライアントを作らない', async () => {
      const mod = await loadModule(unconfiguredProduction);

      expect(mod.posthog).toBeUndefined();
      expect(instances).toHaveLength(0);
    });

    it('空入力: 本番で両方とも空文字のときも例外を投げず、クライアントを作らない', async () => {
      const mod = await loadModule({ NODE_ENV: 'production', POSTHOG_PROJECT_TOKEN: '', POSTHOG_HOST: '' });

      expect(mod.posthog).toBeUndefined();
      expect(instances).toHaveLength(0);
    });

    it('空入力: 本番でトークンだけあってホストが無いときもクライアントを作らない', async () => {
      const mod = await loadModule({ ...configured, NODE_ENV: 'production', POSTHOG_HOST: undefined });

      expect(mod.posthog).toBeUndefined();
    });

    it('空入力: 本番でトークンが空白だけのときも未設定として扱い、例外を投げずにクライアントを作らない', async () => {
      const mod = await loadModule({ ...configured, NODE_ENV: 'production', POSTHOG_PROJECT_TOKEN: '   ' });

      expect(mod.posthog).toBeUndefined();
      expect(instances).toHaveLength(0);
    });
  });

  describe('異常系', () => {
    it('空入力: 本番以外で POSTHOG_PROJECT_TOKEN が無いと読み込み時に例外を投げる', async () => {
      await expect(loadModule({ ...configured, POSTHOG_PROJECT_TOKEN: undefined })).rejects.toThrow(
        /POSTHOG_PROJECT_TOKEN/
      );
    });

    it('空入力: 本番以外で POSTHOG_HOST が無いと読み込み時に例外を投げる', async () => {
      await expect(loadModule({ ...configured, POSTHOG_HOST: undefined })).rejects.toThrow(/POSTHOG_HOST/);
    });

    it('空入力: 空文字も未設定として扱い、例外を投げる', async () => {
      await expect(loadModule({ ...configured, POSTHOG_PROJECT_TOKEN: '' })).rejects.toThrow(
        /POSTHOG_PROJECT_TOKEN/
      );
    });

    it('空入力: NODE_ENV が未設定でも本番以外として扱い、例外を投げる', async () => {
      await expect(
        loadModule({ NODE_ENV: undefined, POSTHOG_PROJECT_TOKEN: undefined, POSTHOG_HOST: undefined })
      ).rejects.toThrow(/POSTHOG_PROJECT_TOKEN/);
    });

    it('入力: ホストが無いときの例外の文に、設定済みのトークンの値を含めない', async () => {
      const error = await loadModule({ ...configured, POSTHOG_HOST: undefined }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('phc_test_token');
    });

    it.each([
      ['POSTHOG_PROJECT_TOKEN', '   '],
      ['POSTHOG_HOST', ' \t '],
    ])('空入力: 本番以外で空白だけの %s は未設定として例外を投げる', async (name, value) => {
      await expect(loadModule({ ...configured, [name]: value })).rejects.toThrow(new RegExp(name));
    });
  });
});

describe('posthog: クライアントの生成', () => {
  describe('正常系', () => {
    it('トークンとホストを渡し、5 秒のタイムアウト・リトライなし・例外の自動送信ありで作る', async () => {
      await loadModule(configured);

      expect(instances).toHaveLength(1);
      expect(instances[0].token).toBe('phc_test_token');
      expect(instances[0].options).toEqual({
        host: 'https://posthog.example.test',
        enableExceptionAutocapture: true,
        requestTimeout: 5000,
        fetchRetryCount: 0,
      });
    });

    it('入力: トークンとホストの前後の空白は外して渡す', async () => {
      await loadModule({ ...configured, POSTHOG_PROJECT_TOKEN: ' phc_test_token\n', POSTHOG_HOST: ' https://posthog.example.test ' });

      expect(instances[0].token).toBe('phc_test_token');
      expect(instances[0].options.host).toBe('https://posthog.example.test');
    });
  });
});

describe('posthog: capturePostHogEvent', () => {
  describe('正常系', () => {
    it('distinctId・event・properties を capture に渡し、flush を待つ', async () => {
      const mod = await loadModule(configured);
      const client = instances[0];

      await mod.capturePostHogEvent('strapi_cms', 'article_created', { a: 1 });

      expect(client.capture).toHaveBeenCalledWith({
        distinctId: 'strapi_cms',
        event: 'article_created',
        properties: { a: 1 },
      });
      expect(client.flush).toHaveBeenCalledTimes(1);
    });

    it('空入力: properties が空オブジェクトでもそのまま capture に渡す', async () => {
      const mod = await loadModule(configured);

      await mod.capturePostHogEvent('strapi_cms', 'article_created', {});

      expect(instances[0].capture).toHaveBeenCalledWith({
        distinctId: 'strapi_cms',
        event: 'article_created',
        properties: {},
      });
    });

    it('空入力: クライアントが無い（本番で未設定）ときは何もせずに終わる', async () => {
      const mod = await loadModule(unconfiguredProduction);

      await expect(mod.capturePostHogEvent('x', 'y', {})).resolves.toBeUndefined();
    });

    it('flush が先に終わったときは見切りのタイマーを残さない', async () => {
      const mod = await loadModule(configured);
      vi.useFakeTimers();

      await mod.capturePostHogEvent('x', 'y', {});

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('異常系', () => {
    it('サーバ: flush が失敗しても例外を外へ出さず、stderr に記録する', async () => {
      const mod = await loadModule(configured);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      instances[0].flush.mockRejectedValueOnce(new Error('network down'));

      await expect(mod.capturePostHogEvent('x', 'y', {})).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('PostHog flush failed', expect.any(Error));
    });

    it('サーバ: flush が AbortError（requestTimeout の打ち切り）で失敗しても例外を外へ出さない', async () => {
      const mod = await loadModule(configured);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      instances[0].flush.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

      await expect(mod.capturePostHogEvent('x', 'y', {})).resolves.toBeUndefined();
    });

    it('サーバ: flush が終わらないときは 5 秒で見切って先へ進む', async () => {
      const mod = await loadModule(configured);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();
      instances[0].flush.mockReturnValueOnce(new Promise(() => {}));

      let settled = false;
      const pending = mod.capturePostHogEvent('x', 'y', {}).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith('PostHog flush timed out after 5000ms');
    });

    it('サーバ: 失敗・時間切れのログにトークンの値を出さない', async () => {
      const mod = await loadModule(configured);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();
      instances[0].flush.mockRejectedValueOnce(new Error('503 Service Unavailable'));
      instances[0].flush.mockReturnValueOnce(new Promise(() => {}));

      await mod.capturePostHogEvent('x', 'y', {});
      const pending = mod.capturePostHogEvent('x', 'y', {});
      await vi.advanceTimersByTimeAsync(5000);
      await pending;

      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(loggedText(errorSpy)).not.toContain('phc_test_token');
    });
  });
});

describe('posthog: capturePostHogException', () => {
  describe('正常系', () => {
    it('例外・distinctId・properties を captureException に渡し、flush を待つ', async () => {
      const mod = await loadModule(configured);
      const client = instances[0];
      const error = new Error('boom');

      await mod.capturePostHogException(error, 'strapi_server', { status_code: 500 });

      expect(client.captureException).toHaveBeenCalledWith(error, 'strapi_server', { status_code: 500 });
      expect(client.flush).toHaveBeenCalledTimes(1);
    });

    it('空入力: 例外が undefined・properties が空でもそのまま captureException に渡す', async () => {
      const mod = await loadModule(configured);

      await mod.capturePostHogException(undefined, 'strapi_server', {});

      expect(instances[0].captureException).toHaveBeenCalledWith(undefined, 'strapi_server', {});
    });

    it('空入力: クライアントが無いときは何もせずに終わる', async () => {
      const mod = await loadModule(unconfiguredProduction);

      await expect(mod.capturePostHogException(new Error('boom'), 'x', {})).resolves.toBeUndefined();
    });
  });

  describe('異常系', () => {
    it('サーバ: flush が失敗しても例外を外へ出さない', async () => {
      const mod = await loadModule(configured);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      instances[0].flush.mockRejectedValueOnce(new Error('network down'));

      await expect(mod.capturePostHogException(new Error('boom'), 'x', {})).resolves.toBeUndefined();
    });

    it('サーバ: flush が終わらないときは 5 秒で見切って先へ進む（元の例外の再送出を待たせない）', async () => {
      const mod = await loadModule(configured);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.useFakeTimers();
      instances[0].flush.mockReturnValueOnce(new Promise(() => {}));

      const pending = mod.capturePostHogException(new Error('boom'), 'x', {});
      await vi.advanceTimersByTimeAsync(5000);

      await expect(pending).resolves.toBeUndefined();
    });
  });
});

describe('posthog: shutdownPostHog', () => {
  describe('正常系', () => {
    it('クライアントの shutdown を呼ぶ', async () => {
      const mod = await loadModule(configured);

      await mod.shutdownPostHog();

      expect(instances[0].shutdown).toHaveBeenCalledTimes(1);
    });

    it('空入力: クライアントが無いときも例外を投げない', async () => {
      const mod = await loadModule(unconfiguredProduction);

      await expect(mod.shutdownPostHog()).resolves.toBeUndefined();
    });
  });

  describe('異常系', () => {
    it('サーバ: shutdown（残りの送信）が失敗したときは例外をそのまま返す', async () => {
      const mod = await loadModule(configured);
      const error = new Error('network down');
      instances[0].shutdown.mockRejectedValueOnce(error);

      await expect(mod.shutdownPostHog()).rejects.toBe(error);
    });
  });
});
