import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lockDownEndUserAuth } from '../src/users-permissions-lockdown';

// strapi の偽物。plugin store（advanced）と、role の findOne・permission の deleteMany だけを持つ
const createFakeStrapi = ({
  advanced,
  publicRole = { id: 2 },
  deleted = 0,
}: {
  advanced?: Record<string, unknown> | null;
  publicRole?: { id: number } | null;
  deleted?: number;
} = {}) => {
  const store = {
    get: vi.fn(async () => advanced),
    set: vi.fn(async () => {}),
  };
  const roleQuery = { findOne: vi.fn(async () => publicRole) };
  const permissionQuery = { deleteMany: vi.fn(async () => ({ count: deleted })) };
  const strapi = {
    store: vi.fn(() => store),
    db: {
      query: vi.fn((uid: string) => (uid === 'plugin::users-permissions.role' ? roleQuery : permissionQuery)),
    },
    log: { info: vi.fn() },
  };
  return { strapi, store, roleQuery, permissionQuery };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (fake: ReturnType<typeof createFakeStrapi>) => lockDownEndUserAuth(fake.strapi as any);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('lockDownEndUserAuth', () => {
  describe('正常系', () => {
    it('allow_register が true なら false にし、ほかの advanced の設定は残す', async () => {
      const fake = createFakeStrapi({ advanced: { allow_register: true, unique_email: true, default_role: 'authenticated' } });

      await run(fake);

      expect(fake.strapi.store).toHaveBeenCalledWith({ type: 'plugin', name: 'users-permissions' });
      expect(fake.store.set).toHaveBeenCalledWith({
        key: 'advanced',
        value: { allow_register: false, unique_email: true, default_role: 'authenticated' },
      });
    });

    it('既に allow_register が false なら書き換えない（冪等）', async () => {
      const fake = createFakeStrapi({ advanced: { allow_register: false } });

      await run(fake);

      expect(fake.store.set).not.toHaveBeenCalled();
    });

    it('Public ロールの権限を全部消す（Content API の find も auth の register も）', async () => {
      const fake = createFakeStrapi({ advanced: { allow_register: false }, deleted: 16 });

      await run(fake);

      expect(fake.roleQuery.findOne).toHaveBeenCalledWith({ where: { type: 'public' } });
      expect(fake.permissionQuery.deleteMany).toHaveBeenCalledWith({ where: { role: { id: 2 } } });
      expect(fake.strapi.log.info).toHaveBeenCalledWith(expect.stringContaining('16 件'));
    });

    it('消すものが無ければログを出さない（2 回目以降の起動）', async () => {
      const fake = createFakeStrapi({ advanced: { allow_register: false }, deleted: 0 });

      await run(fake);

      expect(fake.strapi.log.info).not.toHaveBeenCalled();
    });

    it('空入力: advanced がまだ無ければ allow_register: false だけで作る', async () => {
      const fake = createFakeStrapi({ advanced: null });

      await run(fake);

      expect(fake.store.set).toHaveBeenCalledWith({ key: 'advanced', value: { allow_register: false } });
    });

    it('空入力: Public ロールが無ければ権限の削除をしない', async () => {
      const fake = createFakeStrapi({ advanced: { allow_register: false }, publicRole: null });

      await run(fake);

      expect(fake.permissionQuery.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('異常系', () => {
    it('サーバ: 権限の削除が失敗（DB の例外）したら、その例外を返す（起動を止める）', async () => {
      const fake = createFakeStrapi({ advanced: { allow_register: false } });
      const error = new Error('db failure');
      fake.permissionQuery.deleteMany.mockRejectedValueOnce(error);

      await expect(run(fake)).rejects.toBe(error);
    });

    it('サーバ: plugin store の読み取りが失敗したら、その例外を返す', async () => {
      const fake = createFakeStrapi();
      const error = new Error('store failure');
      fake.store.get.mockRejectedValueOnce(error);

      await expect(run(fake)).rejects.toBe(error);
      expect(fake.permissionQuery.deleteMany).not.toHaveBeenCalled();
    });
  });
});
