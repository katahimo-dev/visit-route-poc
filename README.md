# 訪問ルートAI PoC

仙台市「先端テクノロジー・データ利活用ユースケース創出支援事業」の実証（3事業所×4件、2回構成）で、協力法人に使ってもらうための PoC アプリ。

- スタッフ（スマホ・PWA）：きょうの回る順番、はじめる／おわる、勤務中だけの位置計測とジオフェンスによる到着・退出、勤怠の確認と訂正
- 管理者（PC）：スタッフ・訪問先・訪問予定・手作業の順番の登録、AI案（移動時間予測＋割当と順番の最適化）との比較、勤怠の承認と CSV
- 運営者：実証データ CSV（仮名ID）

設計：[docs/prd.md](docs/prd.md)（要件・α版の最小構成 §9）／[docs/design.md](docs/design.md)／[docs/adr/](docs/adr/)／最適化 API [docs/api/openapi.yaml](docs/api/openapi.yaml)。
AI エージェント向けのルールは [AGENTS.md](AGENTS.md)、設計の手順は `.claude/skills/solo-architecture-design/`。

## 構成

| ディレクトリ | 中身 |
|---|---|
| `web/` | React + Vite + TypeScript の PWA（Firebase Hosting） |
| `functions/` | Cloud Functions（TypeScript）：招待・住所変換・移動時間予測・AI案・勤怠・CSV |
| `optimizer/` | Cloud Functions（Python + OR-Tools）：割当と順番の最適化（VRPTW） |
| `packages/shared/` | zod の契約（Firestore 文書・Callable）と純粋関数（時刻・距離・ルート評価） |
| `firestore.rules` | 事業所の分離（`orgs/{orgId}` ＋ カスタムクレーム） |
| `scripts/` | 事業所の開設・デモデータ・通し確認 |

## ローカルで動かす

必要なもの：Node 22、pnpm 11、Java（Firestore エミュレーター）、uv（Python）。

```bash
pnpm install
cp functions/.secret.local.example functions/.secret.local   # 空のままなら移動時間は直線距離の概算
cp web/.env.example web/.env.development.local               # VITE_USE_EMULATORS=true

# 3つのターミナルで
(cd optimizer && uv sync && uv run python dev_server.py)     # :8090
pnpm emulators                                               # Auth :9099 / Firestore :8080 / Functions :5001 / UI :4000
pnpm --filter web dev                                        # :5173

pnpm seed     # デモデータ（仙台市の公共施設を擬人化した架空のスタッフ・利用者さん）
pnpm smoke    # 通し確認（AI案 → 記録 → 勤怠 → 承認 → CSV）
```

ログイン：`admin@example.com`（管理者）／`staff1@example.com`（スタッフ）／`operator@example.com`（運営者）。
メールリンクはエミュレーター UI（http://127.0.0.1:4000/auth）に出る。

`pnpm emulators` / `pnpm test:rules` は `scripts/dev/honor-no-proxy.cjs` を読み込む（HTTPS_PROXY がある環境で、firebase-tools が NO_PROXY を無視してローカル宛ての通信をプロキシに送る問題の回避。外部への通信はそのままプロキシを通る）。

## テスト

```bash
pnpm typecheck
pnpm lint
pnpm test          # 単体（shared・functions）
pnpm test:rules    # セキュリティルール（エミュレーター）
(cd optimizer && uv run pytest && uv run ruff check)
```

## デプロイ（実証用プロジェクト）

実証用のプロジェクトは `corded-academy-502703-f5`（`.firebaserc`）。`OPTIMIZER_URL` は `functions/.env.corded-academy-502703-f5`。

- Node は 22 を使う。Node 26 では HTTPS_PROXY がある環境で firebase-tools の通信が失敗する（`invalid onError method`）。
- HTTPS_PROXY がある環境では、`firebase deploy` にも `NODE_OPTIONS=--require=$(pwd)/scripts/dev/honor-no-proxy.cjs` を付ける（付けないと関数の読み込みがタイムアウトする）。
- optimizer のデプロイには `optimizer/venv`（`python -m venv venv` → `venv` の pip で `requirements.txt`）が要る。アップロードからは除外している（firebase.json の `ignore`）。

1. Firebase プロジェクトを作り（Blaze）、Authentication の「メールリンク」を有効にする。リージョンは asia-northeast1。
2. `firebase use <project>`、Secret Manager に `MAPS_SERVER_KEY`（Routes API・Geocoding API を有効化したサーバー用キー）。
3. `firebase deploy --only functions:optimizer` → 出てきた URL を `functions/.env.<project>` の `OPTIMIZER_URL` に書く。
   最適化サービスは `invoker="private"`。業務関数のサービスアカウント（既定は `<project-number>-compute@developer.gserviceaccount.com`）に、その Cloud Run サービスの `roles/run.invoker` を付ける。
   比較用の OSRM 仙台版（ADR-0005）：`osrm/deploy.sh <project>` → 出てきた `OSRM_URL` を同じファイルに書く。書かなければ比較値は残さない。
4. `web/.env.production.local` に Firebase の Web 設定を書き、`pnpm --filter web build`。
5. `firebase deploy --only firestore,functions:default,hosting`。
6. 事業所の開設：`GCLOUD_PROJECT=<project> pnpm org:create -- <orgId> <事業所名> <sitter|care|nursing|other> <管理者メール> [--operator <運営者メール>]`。
   スタッフは管理者画面で登録して「招待」すると、本人がアプリを開いてログインメールを受け取れる。

## 移動時間の比較（分析）

実証データCSV（`移動時間_予測と実測_<期間>.csv`）を渡すと、直線距離の概算・Google・OSRM・それぞれ×補正を実測と比べた表を出す（ADR-0005）。

```bash
python3 analysis/compare_travel_time.py 移動時間_予測と実測_*.csv
```

## 既知の制約（α版）

- 位置は PWA でアプリを開いている間だけ計測（ADR-0002）。閉じていた間の到着は「はじめる」時刻で補い、印を付ける。
- AI案の行列は1日1つの移動手段（スタッフで最も多いもの）・代表の出発時刻で計算する。
- スタッフ画面の移動時間は直線距離からの目安（地図APIの予測表示は改修版）。
- 比較画面・手直しと決定・おすすめ通知・交通費・比較手法は改修版（PRD §9）。
