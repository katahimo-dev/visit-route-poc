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

ログイン：`admin@example.com`（管理者）／`staff1〜8@example.com`（スタッフ）／`operator@example.com`（運営者）。
ログインコード（6桁）はエミュレーターの関数ログ（http://127.0.0.1:4000/logs）に出る。ログイン画面の「デモで試す」（`VITE_DEMO_LOGIN=true`）ならメールなしで入れる。

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

1. Firebase プロジェクトを作り（Blaze）、Authentication を有効にする。リージョンは asia-northeast1。
   ログインはメールの6桁コード（ADR-0007）。メールは拡張機能 Trigger Email（`firebase ext:install firebase/firestore-send-email`、コレクション `mail`、SMTP は事業者のものを設定）で送る。
   業務関数のサービスアカウントに、自分自身への `roles/iam.serviceAccountTokenCreator` を付ける（ログイン用トークンの署名に使う）。
   Authentication の「メールリンク」は無効のままにする（使わない）。
   Firestore の TTL ポリシーを `loginCodes` と `mail` の `expireAt` に設定する（コード・送信済みメールを1日で消す）：
   `gcloud firestore fields ttls update expireAt --collection-group=loginCodes --enable-ttl`（`mail` も同様）
2. `firebase use <project>`、Secret Manager に `MAPS_SERVER_KEY`（Routes API・Geocoding API を有効化したサーバー用キー）。
3. `firebase deploy --only functions:optimizer` → 出てきた URL を `functions/.env.<project>` の `OPTIMIZER_URL` に書く。
   最適化サービスは `invoker="private"`。業務関数のサービスアカウント（既定は `<project-number>-compute@developer.gserviceaccount.com`）に、その Cloud Run サービスの `roles/run.invoker` を付ける。
   比較用の OSRM 仙台版（ADR-0005）：`osrm/deploy.sh <project>` → 出てきた `OSRM_URL` を同じファイルに書く。書かなければ比較値は残さない。
4. `web/.env.production.local` に Firebase の Web 設定を書き、`pnpm --filter web build`。
5. `firebase deploy --only firestore,functions:default,hosting:demo`（画面の置き場所は下の「画面のアドレス」）。
6. 事業所の開設：`GCLOUD_PROJECT=<project> pnpm org:create -- <orgId> <事業所名> <sitter|care|nursing|other> <管理者メール> [--operator <運営者メール>]`。
   スタッフは管理者画面で登録して「招待」すると、本人がアプリを開いてログインコードを受け取れる。
7. 下の「デモ期間から本番への切り替え」の順に進める。

## 画面のアドレス

Hosting は1つのプロジェクトに複数のサイトを置いている（`.firebaserc` の targets）。

| target | アドレス | 中身 |
|---|---|---|
| `demo` | https://katahimo-visit-route-demo.web.app | デモ期間の画面（`VITE_DEMO_LOGIN=true` のビルド） |
| `prod` | https://katahimo-visit-route.web.app | 本番用に名前だけ確保。本番への切り替えで使い始める |
| `legacy` | https://corded-academy-502703-f5.web.app | 旧アドレス。`hosting/legacy` がデモのサイトへ転送し、旧アドレスで入れたアプリの Service Worker を外す |

- PWA はアドレスに結びつく（変えると、スタッフはアプリの入れ直しとログインのやり直しになり、未送信の記録は引き継がれない）。本番のアドレスは、協力法人のスタッフがインストールする前に決めて、その後は変えない
- 本番への切り替えでは、firebase.json の `hosting` に `prod`（`web/dist`、デモの設定を外したビルド）を足して `firebase deploy --only hosting:prod`。デモのサイトは `legacy` と同じ転送にするか、`firebase hosting:disable --site katahimo-visit-route-demo` で止める

## デモ期間から本番への切り替え（ADR-0007）

実証用プロジェクトは、まずデモ（架空の事業所）で画面を見てもらい、指摘を直してから、デモを外して協力法人の実データで検証する。

**デモ期間**（今の設定）
- `functions/.env.corded-academy-502703-f5` に `DEMO_ORG_ID=demo`。画面は `web/.env.production.local` に `VITE_DEMO_LOGIN=true` を書いてビルド
- データ：`SEED_PROJECT=corded-academy-502703-f5 pnpm seed`（GOOGLE_APPLICATION_CREDENTIALS か gcloud の ADC で。ADC の課金先が別のプロジェクトなら `GOOGLE_CLOUD_QUOTA_PROJECT=corded-academy-502703-f5` も付ける）。スタッフ8人・訪問先20か所。予定は実行日から `SEED_UNTIL`（既定 2026-11-30）まで毎日入る（平日は17件前後、土日はスタッフ3人で8件）。入れ直すと実行日以降の予定・AI案は作り直す（同じ日は同じ予定になる。スタッフの記録がある日と、過去の記録・勤怠はそのまま）
- ログイン画面の「デモで試す」で、管理者か、選んだスタッフとしてメールなしで入れる（スタッフはきょうの件数つきで並ぶ）。デモの印（`demo: true`）のある事業所にしか入れない
- この間は招待が止まり、コードのログインは運営者だけになる（誰でも管理者になれるので、他人のアドレスへの送信の踏み台にしない）。地図APIのキーは無くてよい（移動時間は直線距離の概算）
- 運営者の作業（実証データの CSV 出力など）をデモ期間中にするなら Trigger Email を用意する。用意しなければ、運営者の作業は切り替え後に行う

**本番への切り替え**（デモの評価と調整が終わってから）
1. `GCLOUD_PROJECT=corded-academy-502703-f5 pnpm tsx scripts/endDemo.ts` で消す対象を確かめ、`--apply` を付けて実行（デモの事業所と、デモ・@example.com のアカウントを消す）
2. `functions/.env.corded-academy-502703-f5` から `DEMO_ORG_ID` を消し、`VITE_DEMO_LOGIN` を外して画面をビルド
3. 上の手順1・2（Trigger Email・TTL・トークン署名の権限、`MAPS_SERVER_KEY`）を用意して `firebase deploy`。画面は本番のサイトに出す（下の「画面のアドレス」）
4. `pnpm org:create` で協力法人の事業所を作り、管理者を招待する

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
