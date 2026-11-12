# Supabase セットアップ

Tree Mapper を複数人で共有するためのバックエンド (Supabase) の準備手順です。
このフォルダの内容は **データベースの設計図 (SQL)** と、その検証テストです。アプリ本体はまだ Supabase につながっていません (つなぐのは次の PR 以降)。

| 場所 | 内容 |
|---|---|
| `migrations/*.sql` | テーブル・権限 (RLS)・トリガー・画像の保存先を作る SQL |
| `tests/schema.test.mjs` | 上の SQL を手元で実行して、権限や制約が意図どおりか確かめるテスト |

## 権限の考え方

- 読み書きできるのは、**`members` テーブルにメールが登録された人だけ**です。
- Google でログインできても、`members` にいなければ、データは何も見えず、何も書けません。
- ピン・エリア・マップは物理削除できません (削除は `deleted_at` を入れる論理削除)。
- 画像は非公開の保存先 (`map-images` / `pin-photos`) に置き、メンバーだけが読み書きできます。
- 端末ごとの設定 (表示するグループ、開いているマップ) は、これまで通り端末に残ります。

## 手順

画面の名前は、Supabase 側の更新で変わることがあります。見当たらないときは近い名前の項目を探してください。

### 1. プロジェクトを作る

1. <https://supabase.com> でアカウントを作り、**New project** を作成します。
2. Region は **Northeast Asia (Tokyo)** を選びます。
3. データベースのパスワードを決め、**パスワードマネージャなどに保管**します (後から画面で再表示できません)。

### 2. SQL を実行する

1. ダッシュボードの **SQL Editor** を開きます。
2. `migrations/20261112000000_init.sql` の中身をすべて貼り付けて、**Run** を押します。
3. エラーなく終われば完了です。**同じ SQL を2回実行しないでください** (2回目はテーブルが既にあるというエラーになります)。やり直すときは、先にプロジェクトを作り直すか、ご相談ください。

### 3. メンバーを追加する

追加するまで、**誰もデータにアクセスできません**。SQL Editor で次を実行します。

```sql
insert into members (email) values ('あなたのGoogleアカウントのメール@gmail.com');
```

- メールは**小文字**で入力してください (大文字だとエラーになります)。
- 追加は、**Table Editor** の `members` テーブルからでもできます。
- メールアドレスをこのリポジトリ (公開) に書かないでください。

### 4. 接続情報を控える

**Project Settings → API** (または Connect) に、次の2つがあります。

- Project URL (`https://xxxx.supabase.co`)
- **anon (public / publishable) キー**

> **`service_role` (secret) キーは、アプリにもリポジトリにも絶対に入れません。** 全データに制限なくアクセスできるキーです。アプリに入れてよいのは anon キーだけです。

アプリには環境変数で渡します (次の PR 以降で使います)。

| 変数名 | 設定する場所 |
|---|---|
| `VITE_SUPABASE_URL` | Netlify の Environment variables / 手元の `.env.local` |
| `VITE_SUPABASE_ANON_KEY` | 同上 |

手元で試すときは、リポジトリ直下の `.env.example` を `.env.local` にコピーして値を入れます (`.env.local` は git に入りません)。

### 5. Google ログインの設定 (ログインを実装する PR で行います)

今は不要です。そのときに、Google Cloud でログイン用の OAuth クライアントを作り、Supabase の **Authentication → Providers → Google** に設定します。

## 動作確認 (本番の Supabase に適用した後)

`tests/schema.test.mjs` は、本物の Supabase ではなく、手元の Postgres (PGlite) と代用環境での検証です。適用後に、次も確認してください。

1. **Table Editor** で、`maps` / `pins` / `areas` / `species` / `groups` / `members` が作られていて、各テーブルに **RLS enabled** と表示されている。
2. **Storage** に `map-images` と `pin-photos` があり、どちらも **Private**。
3. **Database → Publications** の `supabase_realtime` に、`maps` / `pins` / `areas` / `species` / `groups` が入っている (`members` は入っていない)。

## SQL を変更するとき

- 一度適用した SQL は書き換えず、`migrations/` に**新しい日付のファイルを追加**します。
- 変更後は、次のテストを実行してください。

```bash
npm i --no-save @electric-sql/pglite
node supabase/tests/schema.test.mjs
```

`ALL PASSED` と出れば、権限と制約は意図どおりです。
