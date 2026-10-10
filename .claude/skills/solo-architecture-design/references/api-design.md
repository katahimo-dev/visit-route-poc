# API設計：境界の「契約」を書く

APIは **仕様** であり **契約**。呼び出し側は契約だけを信じて使い、提供側は契約を守る限り中身を自由に変えてよい。
契約が明確なら、AIエージェントは仕様をハルシネーションで作らない。

## 1. 名詞と動詞を抜き出す（リソース指向）

PRDの要件文から：
- 名詞 → **リソース**（業務データ）
- 動詞 → **メソッド**（業務の処理）

| 要件 | 名詞（リソース） | 動詞（メソッド） |
|---|---|---|
| 出版社が本を出版する | 出版社、本 | 作成（CreateBook） |
| 書店が在庫を管理する | 書店、在庫 | 更新（UpdateStock） |
| ユーザーが在庫のある本を注文する | ユーザー、注文、本 | 作成（CreateOrder） |

## 2. リソースを階層で定義する

- 親子関係はパスで表す：`/publishers/{publisher_id}/books/{book_id}`
- 所有者がはっきりしないもの・横断検索したいものはトップレベルにしてもよい
- 他リソースへの参照は **一意な名前（ID・パス）だけを持つ**。中身をコピーしない

```yaml
Order:
  properties:
    name: { type: string, example: "users/u1/orders/o9" }
    items:
      type: array
      items:
        properties:
          book: { type: string, example: "publishers/p1/books/b3" }  # 参照のみ
          quantity: { type: integer, minimum: 1 }
```

## 3. メソッド：まず標準、無理ならカスタム

| 操作 | メソッド名 | REST |
|---|---|---|
| 作成 | CreateBook | `POST /publishers/{p}/books` |
| 取得 | GetBook | `GET /publishers/{p}/books/{b}` |
| 一覧 | ListBooks | `GET /publishers/{p}/books?page_size=&page_token=` |
| 更新 | UpdateBook | `PATCH /publishers/{p}/books/{b}`（更新するフィールドを指定） |
| 削除 | DeleteBook | `DELETE /publishers/{p}/books/{b}` |
| カスタム | ArchiveBook | `POST /publishers/{p}/books/{b}:archive` |
| カスタム | SearchBooks | `GET /books:search?q=` |

ルール：
- パスに動詞を入れない（`/getBooks`、`/createOrder` は避ける）。動詞はHTTPメソッドかカスタムメソッド（`:verb`）で表す
- 一覧は最初からページング（`page_size` と `page_token`）を付ける。後から足すと互換性が壊れる
- 更新は部分更新（PATCH）を基本にし、全置換が必要なら明記する

## 4. エラーを契約に含める

エラーは **業務の言葉** で定義する。内部の例外・SQLエラー・スタックトレースを返さない（漏れのある抽象化）。

| エラーコード | HTTP | 意味 | 呼び出し側の対応 |
|---|---|---|---|
| INVALID_ARGUMENT | 400 | 入力が不正 | 入力を直す。再試行しない |
| UNAUTHENTICATED | 401 | 認証されていない | ログインし直す |
| PERMISSION_DENIED | 403 | 権限がない | 再試行しない |
| NOT_FOUND | 404 | 対象がない | 再試行しない |
| ALREADY_EXISTS | 409 | すでにある | 既存を取得して使う |
| FAILED_PRECONDITION | 409/422 | 状態が条件を満たさない（在庫なしなど） | 状態を確認して判断 |
| RESOURCE_EXHAUSTED | 429 | 回数制限 | 待って再試行 |
| UNAVAILABLE | 503 | 一時的に使えない | 指数バックオフで再試行 |
| INTERNAL | 500 | 想定外 | 再試行は冪等な操作のみ |

エラー本文の形をそろえる：

```json
{ "error": { "code": "FAILED_PRECONDITION", "message": "在庫が不足しています", "details": { "book": "publishers/p1/books/b3", "available": 0 } } }
```

## 5. 失敗のしかたも契約に書く（漏れは完全には防げない）

ネットワーク越しの呼び出しは **成功／業務エラー／不明（タイムアウト）** の3通りがある。

契約に書くこと：
- タイムアウト時間と、呼び出し側の推奨タイムアウト
- 再試行してよいか（**冪等性**）。作成系は `request_id`（Idempotency-Key）を受け取り、同じIDなら同じ結果を返す
- 応答時間の目安、回数制限
- 結果整合で反映が遅れるデータ（在庫表示など）があれば、その旨と遅延の目安

## 6. 互換性と変更

| 変更 | 互換性 |
|---|---|
| 任意フィールド・新メソッド・新エラーの詳細の追加 | 保てる |
| 必須フィールドの追加、フィールド削除・名前変更、型変更 | 壊れる |
| 意味の変更（税抜→税込など） | 壊れる（最も危険・気づきにくい） |
| 列挙値の追加 | 呼び出し側が未知の値を扱えるなら保てる。契約に「未知の値は無視」と書く |

破壊的変更の手順：v2を追加 → v1を非推奨として告知（期限を書く）→ 呼び出し側を移行 → v1を停止。
個人開発で呼び出し側が自分だけでも、モバイルアプリなど**古い版が残る呼び出し側**があるなら同じ手順を踏む。

## 7. 契約の書き方を選ぶ

| 形式 | 向いている場面 |
|---|---|
| OpenAPI（YAML） | HTTP/JSONのREST。最も一般的。モック・クライアント生成が容易 |
| Protocol Buffers（gRPC） | サービス間通信、型を厳密にしたいとき |
| GraphQLスキーマ | 画面ごとに必要なデータが大きく違うとき |
| TypeScriptの型・zodスキーマ | モジュラーモノリス内部の境界、フロントとバックが同じ言語のとき |
| JSON Schema＋取り決め | WebSocket・SSE・イベント（正式なIDLがない） |

内部の境界（モジュール間）でも、**公開する関数と型を1ファイルにまとめた「入口」**を作り、他モジュールはそこ以外をimportしないルールにする。

## 8. イベントの契約（非同期連携）

イベント名は過去形の業務用語：`OrderConfirmed`、`StockReleased`。
書くこと：発行者（持ち主は1つ）、ペイロード、順序保証の有無、重複配信の有無（受信側は冪等に）、保持期間。
