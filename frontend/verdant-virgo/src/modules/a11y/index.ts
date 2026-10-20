// a11y モジュールの公開口。他モジュールはここからだけ import する。
// 部品はすべて .tsx なので、.astro からは client:* を付けずに置けば JS を出さない静的な HTML になる。
// ブラウザで動くコードは ./client から import する。
export * from "./client";
