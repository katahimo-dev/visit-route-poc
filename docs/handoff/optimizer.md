# 作業指示書：optimizer（訪問の割当と順番の最適化）

## 1. 担当範囲
- 責務：入力（スタッフの出発地・勤務時間・移動手段、訪問の位置・時間の約束・所要時間・性別希望・NG、移動時間行列、モード）から、絶対条件を守る割当と順番を返す。守れない訪問は「未割当」とし、原因の条件を返す。状態を持たない。
- 持つデータ（持ち主）：なし
- 提供するAPI：`POST /v1/plans:solve`（docs/api/openapi.yaml）。
- 依存するもの：なし（OR-Tools Routing。ADR-0003）。
- 配置：`optimizer/`（Python）
- 完了の条件：
  - [ ] `order_only` では割当を変えず、順番だけを変える
  - [ ] 時間の約束・勤務時間・性別希望・NG を破る案を返さない（テストで保証）
  - [ ] 同じ入力で同じ結果（探索は解の数で打ち切り、単一スレッド・固定シード）
  - [ ] 1事業所1日（スタッフ8人・訪問30件）を30秒以内に返す
  - [ ] 守れない訪問に原因（`time_window` / `shift` / `gender` / `ng_staff` / `unreachable`）が付く

触ってよい範囲：上記の「配置」に書かれたディレクトリのみ。
触ってはいけない範囲：他コンポーネントの内部、共通設定（変更が必要なら質問する）。

## 2. 守るべき契約
### 提供するAPI
（API一覧の表にこのコンポーネントの行がありません。docs/api/ を確認するか、契約を追加してください）

### エラー方針
Callable は `HttpsError` のコードで返す。`message` は利用者向けの日本語、`details.reason` に業務上の理由コード。

| コード | HTTP | 意味 | 呼び出し側の対応 |
|---|---|---|---|
| INVALID_ARGUMENT | 400 | 入力が不正（`details.fields` に項目） | 入力を直す |
| UNAUTHENTICATED | 401 | 未ログイン | ログインし直す |
| PERMISSION_DENIED | 403 | ロール・事業所が違う | 再試行しない |
| NOT_FOUND | 404 | 対象がない | 再試行しない |
| FAILED_PRECONDITION | 409 | 状態が条件を満たさない（version 不一致・承認済み・手作業案が未登録） | 読み直してやり直す |
| RESOURCE_EXHAUSTED | 429 | 地図APIの日次上限・連打 | 時間をおく |
| UNAVAILABLE | 503 | 地図API・最適化サービスが一時的に使えない | バックオフして再試行 |
| INTERNAL | 500 | 想定外（詳細はログのみ） | 再試行しない |

optimizer の「守れない訪問がある」はエラーではなく、成功応答の `unassigned[]` に原因つきで返す。

### 冪等性・タイムアウト
- 作成系 Callable（`createPlanRun`・`decidePlan`・`importMasterCsv` 適用・`generateDayVisits`）は `requestId` を受け取り、同じIDなら最初の結果を返す（`requests/{requestId}` に記録）。
- スタッフの記録は端末生成の `eventId` を文書IDにするので、再送は同じ文書の作成になり二重にならない（ルールで更新を禁止）。
- タイムアウト：Callable 60秒（`createPlanRun` は 120秒）、optimizer 30秒（打ち切り時は `UNAVAILABLE` ではなく途中までの最良解に `partial: true`）、地図API 10秒×再試行2回。

### 呼び出してよい他コンポーネントのAPI（参考）
| コンポーネント | メソッド | エンドポイント | 概要 |
|---|---|---|---|
| org | Callable | `inviteMember` | メールとロールで招待し、クレームを付ける（admin / operator） |
| org | Callable | `geocodeAddress` | 住所→緯度経度（候補を返す。保存は画面） |
| org | Callable | `importMasterCsv` | スタッフ・訪問先CSVの取込（dry-run → 適用） |
| schedule | Callable | `generateDayVisits` | 繰り返し予定から指定日の訪問を作る（冪等） |
| travel-time | Callable | `trainModel` | 実測から補正モデルの新しい版を作る（operator） |
| planning | Callable | `createPlanRun` | 指定日のAI案を作る |
| planning | Callable | `comparePlans` | 手作業案とAI案を同じ行列で比較 |
| planning | Callable | `decidePlan` | 手直しした案を決定し理由を残す |
| planning | Callable | `respondRecommendation` | スタッフがおすすめに返答（改） |
| attendance | Callable | `correctAttendance` | 本人が勤怠候補を訂正 |
| attendance | Callable | `approveAttendance` | 管理者が承認 |
| attendance | Callable | `exportAttendanceCsv` | 勤怠CSV（月） |
| export | Callable | `exportStudyData` | 実証データCSV（仮名ID） |
| optimizer | POST | `/v1/plans:solve` | VRPTW を解く（業務関数からのみ。IAM） |

詳細な定義：`docs/api/` を参照。

## 3. ルール
`AGENTS.md` に従う。

## 4. 完了の条件
- 上記「完了の条件」のチェック項目をすべて満たす
- テスト・リント・型チェックが通る
- 契約にない仕様を推測して実装した箇所があれば、報告に列挙する

## 5. 背景（参考）
仙台市の実証事業（3事業所×4件、2回構成）で協力法人に使ってもらう、訪問型サービス向けのPoCアプリ。
スタッフは本人のスマホ（PWA）できょうの順番を見て「はじめる」「おわる」を押し、位置情報から到着・退出の候補と勤怠集計が作られる。
管理者は1日の訪問予定と手作業の割当・順番を登録し、AIが作る案（移動時間予測＋割当と順番の最適化）と比べて決める。
実証データ（予測と実測・TTS・手作業案とAI案の計画値）を仮名IDでCSVに出し、KPI（移動時間20〜30%削減、予測誤差±10分以内90%）を判定する。
Firebase（Firestore）中心で、少ない工数（150h）で作り切ることを最優先する。

## 6. やらないこと
- 請求・実績記録票・利用者サイン、業種別の記録テンプレート、日報・カルテの生成AI（案D-3「きろく」）
- 給与計算、既存の勤怠・給与・請求システムとのAPI連携、勤怠の自動確定
- 急なキャンセル時の自動再配置、LINE連携、空き枠の可視化、相性の学習（NG登録のみ）
- 月次シフトの一括自動作成（AI案は1日単位）
- ネイティブアプリ、バックグラウンドでの常時位置追跡（PWAの制約。ADR-0002）
- `katahimo-app`（PostgreSQL版）とのデータ連携・コード共有。画面の考え方だけ参考にする
- 要配慮個人情報（障害の内容・病状・介護度）の保存
