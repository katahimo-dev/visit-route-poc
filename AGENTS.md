# AGENTS.md

このリポジトリで作業するAIコーディングエージェント向けのルール。
設計の正は `docs/design.md`、要件の正は `docs/prd.md`、API契約の正は `docs/api/openapi.yaml`（optimizer）と `packages/shared/src/contracts/`（Callable・Firestore文書の zod スキーマ）。これらと矛盾する実装をしない。

## 作業の原則
- 担当範囲（作業指示書に書かれたコンポーネント）以外のファイルを変更しない
- API契約にない入出力・エラー・デフォルト値を勝手に追加しない。必要なら作業を止めて質問する
- 他コンポーネントのコレクションを書き換えない。読むのはよいが、書くのは持ち主（design.md §4）だけ
- PRD §4・design.md §2 の「やらないこと」を実装しない（請求・日報生成AI・自動再配置など）
- 仕様が不明なときは推測で埋めず、`QUESTIONS:` として最後にまとめて報告する

## ディレクトリ構成
```
web/                         … React + Vite + TypeScript PWA（Firebase Hosting）
  src/features/staff/<機能>/   … スタッフのスマホ画面
  src/features/admin/<機能>/   … 管理者のPC画面
  src/features/availability/   … 稼働時間帯（管理者のカレンダーとスタッフのシフト画面で共用。ADR-0008）
  src/lib/firebase.ts          … SDK 初期化（ここ以外で initializeApp しない）
functions/                   … Cloud Functions（TypeScript, codebase: default）
  src/modules/<コンポーネント名>/
    index.ts                   … 公開する入口（Callable・トリガー。他モジュールはここだけを import）
    domain/                    … 業務ルール・純粋関数（Firebase を import しない）
    infrastructure/            … Firestore・外部APIの実装
optimizer/                   … Cloud Functions（Python, codebase: optimizer）OR-Tools
packages/shared/             … zod スキーマ（文書・Callable 入出力）。web と functions が共有
firestore.rules / firestore.indexes.json / storage.rules
tests/rules/                 … セキュリティルールのテスト（エミュレーター）
analysis/                    … 比較手法・予測モデル学習（オフライン、本番に載せない）
docs/                        … prd.md / design.md / api/ / adr/ / handoff/
```

## コマンド（実装着手時に確定）
- インストール：`pnpm install`、`cd optimizer && uv sync`
- 開発：`firebase emulators:start` と `pnpm --filter web dev`
- テスト：`pnpm test`（vitest）、`pnpm test:rules`（エミュレーター）、`cd optimizer && uv run pytest`
- フォーマット・リント：`pnpm lint`（biome）、`uv run ruff check`
- 型チェック：`pnpm typecheck`

## 規約
- 言語：TypeScript（strict）、Python 3.12。コメント・ドキュメント・コミットメッセージは日本語
- データ：すべて `orgs/{orgId}/{collection}` 配下。`orgId` は認証トークンのクレームから取り、リクエストの値を信用しない
- スタッフの本人確認：`staffId` は `request.auth.uid` から引く。画面が送る staffId を信用しない
- 書き込みの検査：画面からの直接書き込みは firestore.rules で持ち主・型・列挙を検査し、同じ形を zod でも定義する。ルールを変えたら tests/rules を足す
- スタッフの記録（events）は端末生成 UUID を文書IDにし、作成のみ（更新・削除禁止）
- 位置情報：勤務中だけ取得。ログ・エラーに位置・氏名・住所を出さない
- エラー：Callable は `HttpsError`（design.md §5 のコード）。`message` は利用者向けの日本語、内部例外の文言を返さない
- 再現性：AI案・予測には入力スナップショット・モデル版・ソルバー版を必ず保存する。optimizer に乱数・時刻依存を入れない
- 秘密情報：コードに書かない。サーバー用 Maps キーは `defineSecret`
- 画面：主ボタンは1画面1つ（多くて2つ）、オレンジ1色。呼び方は事業所設定の辞書から引き、「お客様」「シッター」を直書きしない

## 完了の定義
- [ ] テスト・リント・型チェック・ルールテストがすべて通る
- [ ] 契約（docs/api・packages/shared）どおりの入出力・エラーになっている
- [ ] 別事業所のデータが読めない・書けないことをテストで確認した（データを触る変更の場合）
- [ ] 変更点と、推測した箇所（あれば）を報告した
