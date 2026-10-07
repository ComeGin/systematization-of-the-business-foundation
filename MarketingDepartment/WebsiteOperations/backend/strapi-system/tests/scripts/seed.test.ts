import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// scripts/seed.js は読み込むと Strapi を起動して main() を実行するので、モジュールとしては読まない。
// Public ロールへ権限を付ける処理が戻っていないかを、ソースの文字列で確かめる（2026-10-07 の結合テストで、
// トークン無しで下書きの記事と author の email が読めることが分かり、付与をやめた）
const source = readFileSync(join(__dirname, '..', '..', 'scripts', 'seed.js'), 'utf8');

describe('scripts/seed.js', () => {
  describe('正常系', () => {
    it('Public ロールに読み取りの権限を付けない（users-permissions の permission を作らない）', () => {
      expect(source).not.toMatch(/plugin::users-permissions\.permission/);
      expect(source).not.toMatch(/setPublicPermissions/);
    });

    it('空入力: Public ロールを探す処理（type: public の role の参照）も持たない', () => {
      expect(source).not.toMatch(/type:\s*'public'/);
    });
  });
});
