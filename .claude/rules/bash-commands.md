# Bash コマンドの書き方ルール

秘匿ファイル（`.env` / `samconfig.toml` / `secrets/`）の保護は
`~/.claude/settings.json` の `permissions.deny` から
`PreToolUse` フック（`~/.claude/hooks/protect-secrets.sh`）へ移行済み。
フックは permission mode に関わらず実行され、該当パスを**ハード拒否**する。

これにより、以前は承認プロンプトになっていた `cd A && cat B` / `< file` /
オプション値でのファイル指定などは**プロンプトなしで実行できる**。

## 禁止（フックがブロックする）

- `.env` / `.env.local` など実体の環境変数ファイルの読み書き
- `samconfig.toml` の読み書き
- `secrets/` 配下の読み書き
- 対象ツールは Bash / Read / Grep / Glob / Edit / Write / NotebookEdit
- `.env.example` / `.env.sample` / `.env.template` / `samconfig.toml.example` は許可

秘匿値が必要な場合は `.env.example` を読むか、ユーザーに確認すること。

## 注意（フックでは防げないので自衛する）

- **`grep -r` / `cp -r` を `.env` を含むディレクトリへ向けない**。
  フックはコマンド文字列に現れたパスしか見ないため、ディレクトリを再帰的に
  辿って `.env` の中身をコンテキストへ引き込む経路は止められない。
  - `.env` の所在: `frontend/next-js/`、`others/Yahoo/`、`others/ecs/createCSV/`、`temp/migrateFolder/`
  - 再帰検索は `grep -r` ではなく **`rg` を使う**。`rg` は `.gitignore` を尊重し、
    `.env` はリポジトリの `.gitignore` に載っているため自動的に除外される。

## 推奨（必須ではないが可読性・安全性のため）

- 読み取り対象は可能な限り**絶対パス**で指定する（どのファイルを触ったかログで追える）
- 一時ファイルは scratchpad ディレクトリを絶対パスで扱う
- `rm` / `rmdir` の対象がワーキングディレクトリ本体・その親・`"$VAR"/*` 形式のときは、
  モードに関わらず承認が必要。対象は具体的なサブパスまで書き下す
