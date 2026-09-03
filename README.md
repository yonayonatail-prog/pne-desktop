# P.N.E. Tauri PC Player

設計書 `P.N.E. Tauri PCプレイヤー MVP 実装設計書 v1.0.md` を基準にしたWindows 11 x64向けTauri 2アプリです。`img/`のWebポータル素材をアプリ内UIへ転用しています。

## 現在動くもの

- ローカル作品ライブラリ、作品準備、名前入力、呼称選択
- フレームワーク非依存Player Core
  - line / reaction_prompt / branch / gate / end
  - 条件評価、effect適用、VOICE / SILENT / NEXT分岐
  - VOICE_YES / VOICE_NO / VOICE_OTHER、CLICK_SINGLE / CLICK_DOUBLEの詳細入力
  - KWS / DTW / click-pattern検出アダプタ契約、信頼度fallback、旧VOICEへの縮約
  - 公共空間モード、クリック機器能力判定、重要分岐の2回確認
  - 通過履歴と、LIVE stateを変更しない履歴再生
- セーブ／続きから再生
  - Tauri: SQLite WAL
  - ブラウザpreview: localStorage
- `pne://open?work_id=<id>` のstrict validation、cold/warm deep link、single instance
- AES-256-GCMで暗号化した開発用`.pne-transfer`、Private LAN一時配信、10分TTL、一度だけの取得
- 設定／診断画面、production CSP、最小Tauri capability
- `.pne` v1のmanifest/assets/scenario契約validatorとcontent graph canonical hash
- 完成版`.pne`のライブラリ取り込み、CRC/SHA-256検証、音声／SE／差し絵のローカル再生
- 同梱の`rain_room`開発fixtureによるオフライン動作確認
- ステートキット台本パック`senpai_script_pack_v02_forced_interpretation.json`の46ノード／音声付きサンプル移植

## 開発起動

前提:

- Windows 11 x64
- Node.js 24系
- Rust 1.98.0（`rust-toolchain.toml`で固定）
- Visual Studio C++ build tools
- WebView2

```powershell
npm install
npm test
npm run tauri:dev
```

ブラウザだけでUI／Player Coreを確認する場合:

```powershell
npm run dev
```

同じ自宅Wi-Fiにつないだスマホから確認する場合も、上記コマンドで起動します。
起動後に表示される `Network` のURL（例: `http://192.168.1.20:1420/`）をスマホで開いてください。
PCとスマホが同じWi-Fiに接続されていること、WindowsファイアウォールがNode.jsのプライベートネットワーク通信を許可していることが必要です。

## ビルド

```powershell
npm run build
npm run tauri:build
```

署名なしの開発実行ファイルだけを作る場合:

```powershell
npx tauri build --debug --no-bundle
```

出力は`src-tauri/target/debug/pne-desktop.exe`です。

## テスト

```powershell
npm test
cd src-tauri
cargo test
cargo check
```

TypeScriptテストはPlayer Coreの分岐・effect・履歴不変性、scenario参照、`.pne` path traversal／case collision、canonical hashを検証します。Rustテストはdeep linkの正常・追加query・重複query・fragment・path traversal相当入力を検証します。

## 開発fixtureとproduction境界

正式サービスの値が未提供のため、現在は`rain_room` fixtureをライブラリへ返します。名前音声は元モックと同じ固定リビジョンのIrodori-TTS fp16モデル（約1.3GB）をアプリへ同梱し、WebGPUでローカル生成します。初回起動時のモデルダウンロードは不要です。生成WAVはIndexedDBへ保存され、名前画面での試聴とfixture本編冒頭の名前スロットへ反映されます。LAN転送パックはまだ契約確認用で、名前clipは含みません。

production配布前に以下を設定し、fixture／開発アダプタを正式実装へ差し替える必要があります。

- Catalog API、exact Web release API、`.pne` CDN allowlist
- `.pne`のストリーミングDL、ZIP64 safe extract、asset SHA-256検証を行うWorkManager
- Irodori-TTSのP.N.E.配布model manifest、Web Worker adapter、voice authorization公開鍵
- DPAPIプロフィール暗号化、生成WAV cacheとasset lease
- スマホWebプレイヤー側の`.pne-transfer`復号・Web release照合・IndexedDB import
- updater公開鍵、Windows署名identity、正式portal/player/API origin
- 音声referenceの再配布・名前slot生成許諾

未設定buildは診断画面で`DEVELOPMENT`と表示し、production channelへ出さない前提です。

## 主なディレクトリ

```text
src/                         React UI、Tauri/browser adapter
packages/player-core/        共通Player Core
packages/pne-schema/         .pne契約validator、content graph hash
src-tauri/src/launch.rs      deep link／single instance
src-tauri/src/persistence.rs SQLite migration／session
src-tauri/src/transfer.rs    AES-GCM／LAN一時server
src-tauri/fixtures/          開発作品fixture
```
