# vlogsmith

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-3776AB)
![Node 20+](https://img.shields.io/badge/node-20%2B-339933)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

Vlog の撮って出し素材を、完成動画・サムネイル・日本語学習ブログ記事・動画ポッドキャストに仕上げるツールです。すべて自分のマシンで動き、AI が提案してあなたが決めます。

vlogsmith はローカルで動く小さな Web アプリです。カメラで撮った動画をドロップすると（もともと DJI Osmo Pocket 向けに作りました）、Whisper でオフライン文字起こしをします。そのあと AI コマンドラインツール（デフォルトは Claude Code）が字幕を校正し、残りの下書きを作ります。大事なところでは毎回止まり、確認してから先へ進みます。

> **はじめに：** もとは一つのチャンネルと一つのブログのための個人用ツールです。UI は簡体字中国語で、AI プロンプトは日本語学習シリーズ向けに書かれており、スタイル上の前提もいくつか組み込まれています。マシン固有の設定はすべて変更できます（[設定](#設定)を参照）。ただ、コンテンツの種類が違う場合はプロンプトの調整が必要です。

## 特長

- **オフライン文字起こし**：[OpenAI Whisper](https://github.com/openai/whisper) をローカルで実行し、タイムコード付きの SRT を作ります。有料の音声 API は不要です。
- **AI による字幕校正**：聞き間違いらしい箇所を AI が見つけ、差分として表示します。一件ずつ採用・無視を選べます。行を選んで「この2行は聞き間違い」「フィラーを消して」のように自然な言葉で指示することもできます。
- **AI CLI は自由に選べる**：標準入力（または引数）でプロンプトを受け取り、テキストか JSON を出力する CLI なら何でも使えます。複数登録してデフォルトを決め、アシスタントで会話ごとに切り替えられます。
- **ジョブごとに一つの履歴**：各ジョブのページに、折りたためる AI アシスタントが付いています。指示・返答・押したボタンがすべて一つのタイムラインに残り、検索やステップ別の絞り込みもできます。
- **学習向けブログ記事**：確定した字幕を「やさしい日本語」の記事（元の文 vs 自然な言い方、文法メモ、まとめ表）に書き直します。形式はシリーズの最新回にそろえ、ワンクリックで Astro ブログへ書き出せます。
- **サムネイル作成**：6枚の候補フレームから1枚選び、文字を編集して 1280×720 のサムネイルを作ります。`pipeline.py` には [YuNet](https://github.com/ShiqiYu/libfacedetection) を使った通行人のぼかし関数もありますが、UI にはまだつないでいません。
- **ハイライト付き焼き込み字幕**：白文字に黒フチ、AI が選んだキーワードは黄色で、ffmpeg + libass で焼き込みます。書き出す前に最初の 50 秒をプレビューできます。
- **動画ポッドキャスト**：整えた台本を一文ずつ、または通しで録り直すと、自動でタイミングを合わせ、ふりがな付き・単語ごとのハイライト付き台本を作ります。
- **YouTube に公開**：OAuth で自分のマシンから直接アップロードします（デフォルトは非公開）。サムネイルも設定し、公開後は動画リンクをブログ記事に書き戻します。
- **本数が増えても管理しやすい**：ダッシュボードにはステータス別タブ、検索、撮影月・ポッドキャスト・YouTube・ブログの状態での絞り込みがあります。一覧は月ごとにまとまり、複数選んで一括削除もできます。
- **環境チェック**：設定ページで、各 AI CLI、ffmpeg（libass 付きか）、Whisper、ブログディレクトリの準備状況がひと目で分かります。

## 仕組み

```
 動画をドロップ
    │
    ▼
 1. 文字起こし ────── ffmpeg → Whisper (small, ja) → AI が修正案を出す
    │
    ▼
 ✋ 字幕 ─────────── 修正案を採用 / 無視、直接編集、AI に依頼
    │
    ▼
 2. ブログ ────────── シリーズの形式で AI が次の回を書く
    │
    ▼
 ✋ ブログ ────────── プレビュー、Markdown 編集、再生成、スキップ
    │
    ▼
 3. サムネと字幕 ──── 候補フレーム + AI コピー + ハイライト語、50 秒プレビュー
    │
    ▼
 ✋ サムネ ────────── フレーム選択、文字編集、字幕サイズ調整
    │
    ▼
 4. 書き出し ──────── ffmpeg で動画全体に字幕を焼き込む
    │
    ▼
 final.mp4 · thumbnail.jpg · transcript.srt  ──▶  （任意）YouTube に公開
```

字幕を確定したあとは、動画ポッドキャストを上の流れと並行して進められます。ジョブページに専用のタブがあります。

## 必要なもの

| 依存関係 | 用途 | 備考 |
|---|---|---|
| macOS | いまのところ macOS でのみ動作確認 | デフォルトフォントはヒラギノ。他の環境では `VLOGSMITH_FONT` を設定 |
| Python 3.9+ | Flask API と処理 | 仮想環境の利用を推奨 |
| Node.js 20+ と npm | フロントエンド（Vite + React） | |
| [`ffmpeg-full`](https://formulae.brew.sh/formula/ffmpeg-full) | 音声・動画処理、字幕の焼き込み | 通常の `brew install ffmpeg` は **libass** を含まず、焼き込みに失敗します |
| AI CLI（例：[Claude Code](https://github.com/anthropics/claude-code)） | 校正、ブログ、サムネ文言、ポッドキャストの注釈 | 任意。未設定なら AI のステップはスキップ |
| Google Cloud の OAuth クライアント | YouTube への公開 | 任意 |

## インストール

```bash
# 1. libass 付きの ffmpeg
brew install ffmpeg-full

# 2. （任意）Claude Code CLI。`claude` を起動して /login で一度ログイン
npm install -g @anthropic-ai/claude-code

# 3. クローンしてインストール
git clone https://github.com/erzhiqianyi/vlogsmith.git
cd vlogsmith
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm --prefix frontend install

# 4. ローカル設定
cp .env.example .env   # 必要に応じてパスを編集
```

## クイックスタート

```bash
./dev.sh
```

`dev.sh` は Flask API をポート 5001、Vite の開発サーバーをポート 5173 で起動します。<http://localhost:5173> を開いてダッシュボードに動画をドラッグすると、ジョブは ✋ のたびに止まって待ちます。

開発サーバーを使わない場合は、一度ビルドして Flask から配信します。

```bash
npm --prefix frontend run build
.venv/bin/python app.py      # http://127.0.0.1:5001
```

## 設定

### 環境変数（`.env`）

| 変数 | デフォルト | 用途 |
|---|---|---|
| `VLOGSMITH_BLOG_DIR` | `~/blog` | 記事の書き出し先の Astro プロジェクト（`src/content/blog/ja/japanese/YYYY/MM/` に保存） |
| `VLOGSMITH_FONT` | ヒラギノ角ゴシック（簡体中文） | サムネと字幕のフォント。日本語の字形を含むこと |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 自動 | Homebrew の `ffmpeg-full` から自動で探します |

`app.py` は起動時に `.env` を読み込みます。すでに設定済みの環境変数が優先されます。

### AI コマンドラインツール

「设置 → AI 命令行工具」（設定 → AI コマンドラインツール）で設定します。各項目は次のとおりです。

- **コマンド**：シェルの書き方で入力します。例：`claude -p --output-format stream-json --verbose --include-partial-messages`
- **プロンプトの渡し方**：標準入力、または最後の引数として追加。
- **出力形式**：テキスト、JSON（結果のキーパスを指定）、Claude Code のストリーム JSON。

Claude Code・Gemini CLI・Codex CLI のプリセットがあります。通しで動作確認したのは Claude のプリセットだけなので、それ以外は追加後に「测试」（テスト）で確認してください。

デフォルトのツールは自動ステップで使われます。アシスタントでは会話ごとに別のツールを選べます。設定は `ai_config.json` に保存され、git の管理対象外です。

### コンテンツのスタイル

`pipeline.py` のプロンプトは特定のチャンネルとブログシリーズ向けです。`CHANNEL_STYLE_NOTES` には過去のタイトル例とサムネのスタイルが入っています。ブログ用プロンプトは、ブログ内で最新の `yasashii-nihongo*.md` の構成をそのままなぞります。自分のコンテンツに合わせてこの二か所を調整してください。

### YouTube

1. [Google Cloud Console](https://console.cloud.google.com/) で **YouTube Data API v3** を有効にします。
2. 種類が **Desktop app** の OAuth クライアント ID を作成します。
3. JSON をダウンロードし、`youtube_client_secret.json` としてプロジェクトのルートに置きます。
4. 「设置 → YouTube」で「连接 YouTube」（YouTube に接続）を押すと、ブラウザで一度だけ認可画面が開きます。

公開フォームのデフォルトの公開範囲とタグも同じページで設定できます。

## ディレクトリ構成

```
vlogsmith/
├── app.py               # Flask JSON API、ジョブの状態遷移、バックグラウンド処理
├── pipeline.py          # 各処理（ffmpeg、Whisper、OpenCV、PIL、プロンプト）。状態を持たない
├── ai_helper.py         # 汎用 AI CLI アダプタ：設定、ストリーミング、呼び出し記録、使用量
├── youtube_helper.py    # OAuth とレジューム可能なアップロード
├── models/yunet.onnx    # YuNet 顔検出モデル（MIT、OpenCV Zoo）
├── templates/theater.html  # 大画面プレーヤー（単独ページ）
├── frontend/            # React + Vite + Tailwind + shadcn/ui
│   └── src/
│       ├── pages/       # Dashboard、JobDetail、Settings
│       ├── components/  # ChatPanel、JobInfo、stages/*、ui/*
│       └── lib/         # API クライアント、ステップ定義、表示用の整形
├── jobs/                # ジョブごとの作業ファイル（git 管理外）
├── .env.example
└── dev.sh
```

## パイプラインの詳細

各ジョブの状態は `jobs/<id>/status.json` にあり、`stage` フィールドで流れが決まります。

| ステージ | 内容 | 次へ進む方法 |
|---|---|---|
| `uploaded` → `transcribing` | 音声抽出、Whisper、AI の修正案 | 自動 |
| `transcript_review` | 字幕の確認 | `POST /api/job/<id>/transcript` |
| `blog_processing` → `blog_review` | ブログ記事の生成と確認 | `POST /api/job/<id>/confirm_blog` または `discard_blog` |
| `caption_processing` → `caption_review` | 候補フレーム、AI コピー、字幕プレビューの生成と確認 | `POST /api/job/<id>/confirm_captions` |
| `rendering_final` → `done` | 動画全体への字幕焼き込み | 自動 |
| `error` | どこかのステップが失敗。UI にエラー全文を表示 | `POST /api/job/<id>/retry`（ディスク上のファイルから続きを再開） |

操作はすべてジョブの処理ログに記録され、AI との会話は `jobs/<id>/chat.json` に保存されます。

## トラブルシューティング

<details>
<summary>字幕の焼き込みで <code>ass</code> / <code>subtitles</code> フィルタが見つからない</summary>

`ffmpeg` ではなく `ffmpeg-full` を入れてください。見つかった ffmpeg に libass が含まれているかは設定ページで確認できます。
</details>

<details>
<summary>AI のステップで CLI が未ログイン、またはタイムアウトになる</summary>

ターミナルで一度その CLI を起動してログインしてください（Claude Code なら `claude` を起動して `/login`）。そのあと設定ページで「测试」（テスト）を押します。使える CLI がない場合、AI のステップはスキップされ、手で入力することになります。
</details>

<details>
<summary>文字起こしや書き出しが遅い</summary>

Whisper も ffmpeg も CPU で動きます。`small` モデルで数分の音声なら数分かかり、長い 4K 動画の再エンコードは 10〜20 分ほどかかることがあります。
</details>

## 既知の制限

- **認証はありません**：`127.0.0.1` でのみ使い、ネットワークに公開しないでください。YouTube の認可情報がこのマシンにあります。
- **再起動すると実行中のステップが止まります**：バックグラウンド処理はプロセス内のスレッドです。止まったら「重试」（再試行）で続きから再開できます。
- **自由な指示は字幕ステップだけ**：ほかのステップでは、アシスタントのクイック操作を使います。
- **UI での顔ぼかしは未対応**：サムネは自動でぼかされないので、公開前に通行人が写っていないか確認してください。
- **YouTube のカテゴリは固定**：アップロードはカテゴリ 22（People & Blogs）固定で、アカウントの1日あたりの API 割り当てを消費します。

## ロードマップ

- [ ] すべてのステップで自由な指示（サムネ文言、ブログ修正、公開）
- [ ] ステップごとのデフォルト AI ツール
- [ ] 永続的なジョブキュー（再起動で止まらない）
- [ ] UI で Whisper モデルを選択
- [ ] サムネのレイアウトを追加
- [ ] 候補フレームのワンクリック顔ぼかし
- [ ] ダッシュボードから字幕の中身を検索
- [ ] 英語 / 日本語 UI

## コントリビュート

Issue や Pull Request を歓迎します。バグ修正より大きな変更は、先に Issue で相談してください。

- バックエンドを変更したら Flask の再起動が必要です。フロントエンドは `npm run dev` 中ならホットリロードされます。
- PR を送る前に、`frontend/` で `npx oxlint src` と `npm run build` を実行してください。
- 確認ステップを追加するときは既存のパターンに従ってください。`run_stage_xxx` で `stage = "xxx_review"` にし、`frontend/src/components/stages/` に確認用コンポーネントを置き、`POST /api/job/<id>/confirm_xxx` で次へ進めます。

## セキュリティ

`youtube_client_secret.json`、`youtube_token.json`、`.env` は git の管理対象外です。コミットやスクリーンショットに含めないでください。セキュリティ上の問題を見つけたら、機密情報を含めずに Issue を立て、非公開で連絡したい旨を書いてください。

## ライセンス

[MIT](LICENSE) © 2026 erzhiqianyi

## 謝辞

[Whisper](https://github.com/openai/whisper) · [FFmpeg](https://ffmpeg.org/) と [libass](https://github.com/libass/libass) · [YuNet / OpenCV Zoo](https://github.com/opencv/opencv_zoo) · [shadcn/ui](https://ui.shadcn.com/) · [Claude Code](https://github.com/anthropics/claude-code)
