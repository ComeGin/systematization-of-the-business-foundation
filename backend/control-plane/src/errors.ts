// 呼び出し側の誤りを表すエラー。index.ts（公開）と cycle/service.ts の両方が使うため、小さなモジュールに置く。
// next-js は instanceof ではなく name で判定する（バンドルをまたぐと別のクラスになるため）。name は変えないこと。

/** 手動の起動・画面の操作の入力が不正（呼び出し側の誤り。画面・API では 4xx にする）。 */
export class ControlPlaneInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneInputError";
  }
}
