// chat モジュールの公開口。他モジュールはここからだけ import する（ブラウザのコードは ./client から）。
// 無料相談の「チャットで質問する」は CTAButton などに data-chat-open を付ければ、ChatLoader が拾って開く。
export * from './client';
export { default as ChatLoader } from './components/ChatLoader.astro';
