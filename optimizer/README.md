# optimizer（訪問の割当と順番の最適化）

OR-Tools Routing で VRPTW を解く、状態を持たないサービス。契約は `docs/api/openapi.yaml`
（`POST /v1/plans:solve`、`GET /v1/version`）、設計は `docs/design.md` §4 optimizer と ADR-0003。

## 構成
- `main.py` … Firebase Cloud Functions 2nd gen の入口（薄いルーターとエラー形）
- `solver/` … Firebase に依存しない純粋モジュール
  - `request.py` 入力の検証、`diagnose.py` 未割当の原因診断、`routing.py` OR-Tools モデル、`service.py` 応答の組み立て
- `tests/` … pytest

## テスト・リント
```bash
cd optimizer
uv sync
uv run pytest        # 性能テスト（8人×30件）は時間上限の20秒まで使うので全体で約20〜30秒
uv run ruff check
```

## ローカル実行
```bash
uv run python -c "import json,sys; from solver import solve; print(json.dumps(solve(json.load(sys.stdin)), ensure_ascii=False))" < request.json
```
Functions のエミュレーターは、リポジトリ直下の `firebase.json` に codebase `optimizer`
（`source: optimizer`、`runtime: python312`）を設定して `firebase emulators:start` で起動する。

## 再現性
- 単一スレッド・乱数なし。`PATH_CHEAPEST_ARC` → `GUIDED_LOCAL_SEARCH`。
- **`limits.solutionLimit`（解の数）で打ち切った場合だけ決定的**（同じ入力 → 同じ出力。`computeMillis` は除く）。
- `limits.timeLimitSeconds` に先に達した場合は到達点がマシンの速さで変わりうるため、`partial: true` を返す。
  既定値（2000件・20秒）では 8人×30件は時間切れ（partial）になることがある。
  完全に再現したい比較実験では `solutionLimit` を小さく、`timeLimitSeconds` を十分大きくする。
- 出力の時刻は、求解後に順番から前詰めで再計算する（最初の訪問先では待たず、出発を遅らせる）。

## 仕様の補足
- 単独でも入らない訪問（性別・NG・到達不能・勤務時間外）は求解せず先に未割当にする（原因は同じ診断関数）。
- 未割当の `reasons` は訪問ごとに1つ（`gender` → `ng_staff` → `unreachable` → `shift` → `time_window` の順）。
- `routes` は入力の全スタッフを入力順に返す（訪問がなければ `stops: []`）。
- 時刻は分に切り捨てて `HH:MM` にする。
- スタッフの休み（`breaks`、ADR-0008）：訪問の作業時間は休みに重ならない。移動は休みにかかってよい（休み明けに向かう移動を許す）。OR-Tools 標準の休み（`SetBreakIntervalsOfVehicle`）は休み中の移動を許さないので使わず、「担当なら作業の開始が休みにかかる区間に入らない」制約を直接書いている。出力の待ち時間には休みの時間を含めない。

## デプロイ
Firebase CLI の codebase 分割でデプロイする（`firebase deploy --only functions:optimizer`）。
Python 3.12、リージョン asia-northeast1、メモリ1GiB、`invoker="private"`（業務関数のサービスアカウントだけ）。
`requirements.txt` を Firebase が読むので、`pyproject.toml` の依存を変えたら揃える。
