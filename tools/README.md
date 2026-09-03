# P.N.E. パッケージCLI

Tauri版と同じ `packages/pne-pack` を使って、作品フォルダの検証とパッキングを行います。JSONや `asset_manifest.json` を手で編集する必要はありません。

```powershell
# 作品フォルダを検証する
npm run pne -- check .\examples\pnepack-incomplete

# AIへ相談するための診断JSONを出す
npm run pne -- check .\examples\pnepack-incomplete --json > diagnostic.json

# 穴開きの編集用パックを作る
npm run pne -- pack .\my-work --editable .\out\my-work.pnepack

# 不足素材がない完成版だけを作る
npm run pne -- pack .\my-work --runtime .\out\my-work.pne

# パッケージの中身を確認する
npm run pne -- inspect .\out\my-work.pne --json
```

## AIに相談するとき

`--json` の出力をそのまま貼り、次の情報を添えてください。

- 使用したP.N.E.バージョン
- `check` または `pack` のコマンド
- 素材ファイルの実際の拡張子
- 声や画像そのものは貼らず、必要ならファイル名だけ

`issues[].code` は安定したエラーコードです。診断JSONに含まれる素材のSHA-256は、素材の内容そのものを復元するものではありません。
