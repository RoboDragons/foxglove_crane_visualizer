#!/usr/bin/env bash
# パネルをビルドしてローカルの Foxglove に配る。
#
# 手で npm run local-install だけを叩くと **ビルドされず古い dist/ が配られる**。
# また入れ先は実行環境のホームなので、Windows 版 Studio を使っている場合は
# そちらにもコピーが要る。両方をまとめてやるためのスクリプト。
set -euo pipefail
cd "$(dirname "$0")"

NODE=node
CLI=node_modules/create-foxglove-extension/dist/bin/foxglove-extension.js
EXT=ibisssl.foxglove-crane-visualizer-0.0.17

# ビルド識別子を埋め込む。パネル上部に出るので、読まれている版が一目で分かる
TAG="$(git rev-parse --short HEAD)-$(date +%m%d-%H%M)"
sed -i "s/^const BUILD_TAG = \".*\";/const BUILD_TAG = \"${TAG}\";/" src/crane_visualizer_panel.tsx

$NODE node_modules/typescript/bin/tsc --noEmit
# **本番ビルドを明示すること。** 既定は development で、React の開発ビルド
# （react-dom.development.js）と eval-source-map が入る。実測で 84 プリミティブ
# あたり約 1.5 ms の上乗せがあった
$NODE "$CLI" build --mode production
$NODE "$CLI" install >/dev/null

# Windows 版 Studio 用。存在するときだけコピーする
for WIN in /mnt/c/Users/*/.foxglove-studio/extensions/"$EXT"; do
  [ -d "$WIN/dist" ] || continue
  cp -f dist/extension.js dist/*.d.ts "$WIN/dist/"
  cp -f package.json "$WIN/"
  echo "配布: $WIN"
done

echo "ビルド識別子: ${TAG}"
echo "Studio を再起動し、パネル上部の Build がこの値になっていることを確認すること"
