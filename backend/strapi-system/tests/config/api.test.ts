import { describe, expect, it } from 'vitest';

import apiConfig from '../../config/api';

// 定数の設定だけで、入力も上流も無いため正常系だけを置く
describe('config/api', () => {
  describe('正常系', () => {
    it('REST の既定の件数は上限を超えない', () => {
      expect(apiConfig.rest.defaultLimit).toBeGreaterThan(0);
      expect(apiConfig.rest.defaultLimit).toBeLessThanOrEqual(apiConfig.rest.maxLimit!);
    });

    it('REST と Document Service の両方で未知のパラメータを拒否する', () => {
      expect(apiConfig.rest.strictParams).toBe(true);
      expect(apiConfig.documents?.strictParams).toBe(true);
      expect(apiConfig.documents?.strictRelations).toBe(true);
    });
  });
});
