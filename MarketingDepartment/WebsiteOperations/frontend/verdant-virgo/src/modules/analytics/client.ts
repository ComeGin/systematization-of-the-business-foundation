// analytics モジュールのブラウザ用の公開口（.astro を含まない）。island・<script> はここから import する。
export { track, getDistinctId } from './lib/posthog';
export { whenIdle } from './lib/idle';
