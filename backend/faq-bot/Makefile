# SAM の BuildMethod: makefile が呼ぶ（cloud/stacks/services/faq-bot.yaml の Metadata）。
# npm を使わず、pnpm（pnpm-workspace.yaml のサプライチェーン対策つき）で依存を入れ、esbuild で 1 ファイルにまとめる。
# @aws-sdk/* は Lambda の実行環境にあるので含めない（package.json の bundle）。
build-FaqBotFunction:
	pnpm install --frozen-lockfile
	pnpm run bundle
	cp dist-lambda/index.mjs dist-lambda/index.mjs.map "$(ARTIFACTS_DIR)/"
