import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('posthog: 環境変数の検証', () => {
  it('本番以外で POSTHOG_PROJECT_TOKEN が無いと読み込み時に例外を投げる', async () => {
    await expect(loadModule({ ...configured, POSTHOG_PROJECT_TOKEN: undefined })).rejects.toThrow(
      /POSTHOG_PROJECT_TOKEN/
    );
  });

  it('本番以外で POSTHOG_HOST が無いと読み込み時に例外を投げる', async () => {
    await expect(loadModule({ ...configured, POSTHOG_HOST: undefined })).rejects.toThrow(/POSTHOG_HOST/);
  });

  it('空文字も未設定として扱い、例外を投げる', async () => {
    await expect(loadModule({ ...configured, POSTHOG_PROJECT_TOKEN: '' })).rejects.toThrow(
      /POSTHOG_PROJECT_TOKEN/
    );
  });

  it('NODE_ENV が未設定でも本番以外として扱い、例外を投げる', async () => {
    await expect(
      loadModule({ NODE_ENV: undefined, POSTHOG_PROJECT_TOKEN: undefined, POSTHOG_HOST: undefined })
    ).rejects.toThrow(/POSTHOG_PROJECT_TOKEN/);
  });

  it('本番では未設定でも例外を投げず、クライアントを作らない', async () => {
    const mod = await loadModule({
      NODE_ENV: 'production',
      POSTHOG_PROJECT_TOKEN: undefined,
      POSTHOG_HOST: undefined,
    });

    expect(mod.posthog).toBeUndefined();
    expect(instances).toHaveLength(0);
  });

  it('本番でトークンだけあってホストが無いときもクライアントを作らない', async () => {
    const mod = await loadModule({ ...configured, NODE_ENV: 'production', POSTHOG_HOST: undefined });

    expect(mod.posthog).toBeUndefined();
  });
});

describe('posthog: クライアントの生成', () => {
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
});

describe('posthog: capturePostHogEvent', () => {
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

  it('クライアントが無いときは何もせずに終わる', async () => {
    const mod = await loadModule({
      NODE_ENV: 'production',
      POSTHOG_PROJECT_TOKEN: undefined,
      POSTHOG_HOST: undefined,
    });

    await expect(mod.capturePostHogEvent('x', 'y', {})).resolves.toBeUndefined();
  });

  it('flush が失敗しても例外を外へ出さず、stderr に記録する', async () => {
    const mod = await loadModule(configured);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    instances[0].flush.mockRejectedValueOnce(new Error('network down'));

    await expect(mod.capturePostHogEvent('x', 'y', {})).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('PostHog flush failed', expect.any(Error));
  });

  it('flush が終わらないときは 5 秒で見切って先へ進む', async () => {
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

  it('flush が先に終わったときは見切りのタイマーを残さない', async () => {
    const mod = await loadModule(configured);
    vi.useFakeTimers();

    await mod.capturePostHogEvent('x', 'y', {});

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('posthog: capturePostHogException', () => {
  it('例外・distinctId・properties を captureException に渡し、flush を待つ', async () => {
    const mod = await loadModule(configured);
    const client = instances[0];
    const error = new Error('boom');

    await mod.capturePostHogException(error, 'strapi_server', { status_code: 500 });

    expect(client.captureException).toHaveBeenCalledWith(error, 'strapi_server', { status_code: 500 });
    expect(client.flush).toHaveBeenCalledTimes(1);
  });

  it('flush が失敗しても例外を外へ出さない', async () => {
    const mod = await loadModule(configured);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    instances[0].flush.mockRejectedValueOnce(new Error('network down'));

    await expect(mod.capturePostHogException(new Error('boom'), 'x', {})).resolves.toBeUndefined();
  });

  it('クライアントが無いときは何もせずに終わる', async () => {
    const mod = await loadModule({
      NODE_ENV: 'production',
      POSTHOG_PROJECT_TOKEN: undefined,
      POSTHOG_HOST: undefined,
    });

    await expect(mod.capturePostHogException(new Error('boom'), 'x', {})).resolves.toBeUndefined();
  });
});

describe('posthog: shutdownPostHog', () => {
  it('クライアントの shutdown を呼ぶ', async () => {
    const mod = await loadModule(configured);

    await mod.shutdownPostHog();

    expect(instances[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('クライアントが無いときも例外を投げない', async () => {
    const mod = await loadModule({
      NODE_ENV: 'production',
      POSTHOG_PROJECT_TOKEN: undefined,
      POSTHOG_HOST: undefined,
    });

    await expect(mod.shutdownPostHog()).resolves.toBeUndefined();
  });
});
