#!/usr/bin/env bash
# 把原作者倉庫的最新程式碼複製到目前的倉庫，但保留這份部署自己的 Cloudflare 設定。
# 用法：在倉庫根目錄執行 bash .github/scripts/sync-upstream.sh
# 可用環境變數 UPSTREAM、UPSTREAM_BRANCH 指定來源（預設 antony910911/grabit 的 main）。
set -euo pipefail

UPSTREAM="${UPSTREAM:-https://github.com/antony910911/grabit}"
BRANCH="${UPSTREAM_BRANCH:-main}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git clone --quiet --depth 1 --branch "$BRANCH" "$UPSTREAM" "$tmp/up"

if [ -f wrangler.toml ]; then
  # 新版的 wrangler.toml，但名稱、資料庫 ID、佇列名稱換回你自己的
  node .github/scripts/merge-wrangler.mjs wrangler.toml "$tmp/up/wrangler.toml" > "$tmp/wrangler.toml"
  keep_config=0
else
  echo "::warning::找不到 wrangler.toml（設定檔可能被改成 wrangler.json），保留你現在的設定檔不更新。"
  keep_config=1
fi

# 換成新版程式碼：先刪掉舊的檔案（新版拿掉的檔案才不會留著），再解開新版。
# .github（這個更新工具本身）和你的設定檔不動。
git ls-files -z | grep -zvE '^(\.github/|wrangler\.(toml|json|jsonc)$)' | xargs -0 -r rm -f --
git -C "$tmp/up" archive HEAD | tar -x -C . \
  --exclude=.github --exclude=wrangler.toml --exclude=wrangler.json --exclude=wrangler.jsonc

if [ "$keep_config" = 0 ]; then
  cp "$tmp/wrangler.toml" wrangler.toml
fi

echo "已同步 $UPSTREAM ($BRANCH) 的最新版：$(git -C "$tmp/up" rev-parse --short HEAD)"
