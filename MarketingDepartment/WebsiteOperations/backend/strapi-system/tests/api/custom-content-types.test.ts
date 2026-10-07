import { describe, expect, it, vi } from 'vitest';

// 自作のコンテンツタイプ（E-01 keyword・E-03 content-plan）と CTA のコンポーネント（E-06）の定義の検査。
// コントローラ・ルーター・サービスは Strapi の factories の生成コードのままなので、uid の取り違えだけを見る。
// どれも定数の定義で、入力も上流も無いため正常系だけを置く

// @strapi/strapi は偽物にする（本物は Strapi 本体一式を読み込む）。factories は渡された uid を記録した印を返すだけ
vi.mock('@strapi/strapi', () => ({
  factories: {
    createCoreController: (uid: string) => ({ kind: 'controller', uid }),
    createCoreRouter: (uid: string) => ({ kind: 'router', uid }),
    createCoreService: (uid: string) => ({ kind: 'service', uid }),
  },
}));

import keywordSchema from '../../src/api/keyword/content-types/keyword/schema.json';
import contentPlanSchema from '../../src/api/content-plan/content-types/content-plan/schema.json';
import ctaComponent from '../../src/components/shared/cta.json';
import keywordController from '../../src/api/keyword/controllers/keyword';
import keywordRouter from '../../src/api/keyword/routes/keyword';
import keywordService from '../../src/api/keyword/services/keyword';
import contentPlanController from '../../src/api/content-plan/controllers/content-plan';
import contentPlanRouter from '../../src/api/content-plan/routes/content-plan';
import contentPlanService from '../../src/api/content-plan/services/content-plan';

type Attribute = Record<string, unknown> & { type: string };
const attributesOf = (schema: { attributes: Record<string, unknown> }) => schema.attributes as Record<string, Attribute>;

describe('api::keyword.keyword（E-01）', () => {
  const attributes = attributesOf(keywordSchema);

  describe('正常系', () => {
    it('下書き・公開を使わない（採否は status で表す）', () => {
      expect(keywordSchema.options.draftAndPublish).toBe(false);
    });

    it('phrase は必須で重複させない', () => {
      expect(attributes.phrase).toMatchObject({ type: 'string', required: true, unique: true });
    });

    it('status は candidate・adopted・skipped で、既定は candidate（agent/keyword-researcher が作る値）', () => {
      expect(attributes.status).toMatchObject({
        type: 'enumeration',
        enum: ['candidate', 'adopted', 'skipped'],
        default: 'candidate',
        required: true,
      });
    });

    it('intent_code は検索意図の 3 分類（E-02。DA-01 と同じ値）', () => {
      expect(attributes.intent_code).toMatchObject({
        type: 'enumeration',
        enum: ['latent', 'semi_explicit', 'explicit'],
      });
    });

    it('monthly_volume は 0 以上の整数', () => {
      expect(attributes.monthly_volume).toMatchObject({ type: 'integer', min: 0 });
    });

    it('コントローラ・ルーター・サービスは api::keyword.keyword で作る', () => {
      for (const created of [keywordController, keywordRouter, keywordService]) {
        expect(created).toMatchObject({ uid: 'api::keyword.keyword' });
      }
    });
  });
});

describe('api::content-plan.content-plan（E-03）', () => {
  const attributes = attributesOf(contentPlanSchema);

  describe('正常系', () => {
    it('下書き・公開を使わない（差し戻しを表すため承認状態は plan_state で持つ）', () => {
      expect(contentPlanSchema.options.draftAndPublish).toBe(false);
    });

    it('title_draft は必須', () => {
      expect(attributes.title_draft).toMatchObject({ type: 'string', required: true });
    });

    it('plan_state は起案・承認待ち・承認済・差し戻しの 4 つで、既定は drafted（agent/content-planner が作る値）', () => {
      expect(attributes.plan_state).toMatchObject({
        type: 'enumeration',
        enum: ['drafted', 'pending_approval', 'approved', 'sent_back'],
        default: 'drafted',
        required: true,
      });
    });

    it('assignee_role は R2・R4', () => {
      expect(attributes.assignee_role).toMatchObject({ type: 'enumeration', enum: ['R2', 'R4'] });
    });

    it('コントローラ・ルーター・サービスは api::content-plan.content-plan で作る', () => {
      for (const created of [contentPlanController, contentPlanRouter, contentPlanService]) {
        expect(created).toMatchObject({ uid: 'api::content-plan.content-plan' });
      }
    });
  });
});

describe('keyword と content-plan の関連', () => {
  const keyword = attributesOf(keywordSchema);
  const contentPlan = attributesOf(contentPlanSchema);

  describe('正常系', () => {
    it('keyword.content_plans（oneToMany）と content-plan.keyword（manyToOne）が互いを指す', () => {
      expect(keyword.content_plans).toMatchObject({
        type: 'relation',
        relation: 'oneToMany',
        target: 'api::content-plan.content-plan',
        mappedBy: 'keyword',
      });
      expect(contentPlan.keyword).toMatchObject({
        type: 'relation',
        relation: 'manyToOne',
        target: 'api::keyword.keyword',
        inversedBy: 'content_plans',
      });
    });

    it('記事への関連は api::article.article を指す', () => {
      expect(keyword.articles).toMatchObject({ type: 'relation', target: 'api::article.article' });
      expect(contentPlan.article).toMatchObject({
        type: 'relation',
        relation: 'oneToOne',
        target: 'api::article.article',
      });
    });
  });
});

describe('shared.cta（E-06 の表示定義）', () => {
  const attributes = attributesOf(ctaComponent);

  describe('正常系', () => {
    it('cta_type は consult・source_dl・chat・booking で必須（DA-01 の正本と同じ値）', () => {
      expect(attributes.cta_type).toMatchObject({
        type: 'enumeration',
        enum: ['consult', 'source_dl', 'chat', 'booking'],
        required: true,
      });
    });

    it('label は必須で、cta_id はその label から作る', () => {
      expect(attributes.label).toMatchObject({ type: 'string', required: true });
      expect(attributes.cta_id).toMatchObject({ type: 'uid', targetField: 'label' });
    });

    it('mautic_form_id は 1 以上の整数（受付定義は Mautic のフォーム）', () => {
      expect(attributes.mautic_form_id).toMatchObject({ type: 'integer', min: 1 });
    });
  });
});
