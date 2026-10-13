# SAM の BuildMethod: makefile が呼ぶ（cloud/stacks/services/admin-auth.yaml の Metadata）。本体と運用の 2 つの関数がある。
# npm を使わず、pnpm（pnpm-workspace.yaml のサプライチェーン対策つき）で依存を入れ、esbuild でそれぞれ 1 ファイルにまとめる。
# @aws-sdk/* は Lambda の実行環境にあるので含めない。pg などは CommonJS で require を呼ぶため、bundle の banner で require を用意している。
# 読み込めることを写す前に確かめる（モジュールの最上位では接続しないので、ネットワークなしで通る）。
build-AdminAuthFunction:
	pnpm install --frozen-lockfile
	pnpm run bundle
	node --input-type=module -e "await import('./dist-lambda/index.mjs')"
	cp dist-lambda/index.mjs dist-lambda/index.mjs.map "$(ARTIFACTS_DIR)/"

build-AdminAuthOpsFunction:
	pnpm install --frozen-lockfile
	pnpm run bundle
	node --input-type=module -e "await import('./dist-lambda/ops.mjs')"
	cp dist-lambda/ops.mjs dist-lambda/ops.mjs.map "$(ARTIFACTS_DIR)/"
