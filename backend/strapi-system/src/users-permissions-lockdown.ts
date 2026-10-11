import type { Core } from '@strapi/strapi';

// users-permissions のエンドユーザーのアカウントは、このシステムでは使わない（管理画面は admin の認証、
// ビルドとエージェントは API トークン・Admin トークンで読む）。起動のたびに次の 2 つをそろえる（冪等）:
//
//   1. エンドユーザーの登録を止める（advanced の allow_register を false）
//   2. Public ロール（トークン無し）の権限を全部外す。Content API の find（Strapi 5 は find の権限だけで ?status=draft を
//      受け付けるので、下書きと author の email がトークン無しで読めた）と、auth の register・forgotPassword などの両方
//
// seed（scripts/seed.js）ではなく bootstrap で行うのは、seed は開発の初回にしか走らず、本番の DB（RDS）や
// 管理画面で権限を付け直した後の状態を戻せないため。users-permissions の bootstrap はロールが 1 つも無いときしか
// 既定の権限を作らず、advanced も無いときしか作らないので、ここで外したものは次の起動で戻らない。
const PLUGIN_STORE = { type: 'plugin', name: 'users-permissions' } as const;
const ROLE_UID = 'plugin::users-permissions.role';
const PERMISSION_UID = 'plugin::users-permissions.permission';

export const lockDownEndUserAuth = async (strapi: Core.Strapi) => {
  const pluginStore = strapi.store(PLUGIN_STORE);
  const advanced = ((await pluginStore.get({ key: 'advanced' })) ?? {}) as Record<string, unknown>;

  if (advanced.allow_register !== false) {
    await pluginStore.set({ key: 'advanced', value: { ...advanced, allow_register: false } });
    strapi.log.info('users-permissions: エンドユーザーの登録（allow_register）を止めた');
  }

  const publicRole = (await strapi.db.query(ROLE_UID).findOne({ where: { type: 'public' } })) as { id: number } | null;

  if (!publicRole) {
    return;
  }

  const { count } = await strapi.db.query(PERMISSION_UID).deleteMany({ where: { role: { id: publicRole.id } } });

  if (count > 0) {
    strapi.log.info(`users-permissions: Public ロールの権限を ${count} 件外した`);
  }
};
