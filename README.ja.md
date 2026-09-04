<p align="center">
  <img src="./apps/web/public/logo-192.png" width="96" height="96" alt="Dibao logo" />
</p>

<h1 align="center">邸报 Dibao</h1>

<p align="center">
  セルフホストできる、source-available / fair-code の個人向け RSS 推薦リーダー。
</p>

<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/Pls-1q43/Dibao"><img alt="GitHub repository" src="https://img.shields.io/badge/GitHub-Pls--1q43%2FDibao-111827?logo=github" /></a>
  <a href="./compose.yaml"><img alt="Docker Compose" src="https://img.shields.io/badge/Docker_Compose-ready-2563eb?logo=docker&logoColor=white" /></a>
  <a href="./docs/release-notes-v0.3.1.md"><img alt="Release notes" src="https://img.shields.io/badge/release_notes-v0.3.1-2f6f5e" /></a>
</p>

---

## 日本語

Dibao は、**セルフホスト RSS リーダー、AI RSS reader、個人向けニュースリーダー、OPML リーダー、ローカル優先の推薦システム、PWA 読書アプリ**です。購読する RSS / Atom フィードはあなたが選びます。Dibao は、そのフィードの内側だけで記事を並べ替え、重複を減らし、検索し、推薦理由を説明します。

新しいコンテンツプラットフォームを作るものではありません。SNS のように知らない情報源を流し込むものでもありません。自分で選んだ RSS を、毎日読みやすい形に整えるためのツールです。

クイックリンク：

- [Dibao が解決すること](#dibao-が解決すること)
- [できること](#できること)
- [Dibao を支援する](#dibao-を支援する)
- [クイックインストール](#クイックインストール)
- [推奨 Provider](#推奨-provider)
- [日常的な使い方](#日常的な使い方)
- [PWA インストール](#pwa-インストール)
- [バックアップとアップグレード](#バックアップとアップグレード)
- [ライセンス](#ライセンス)
- [FAQ](#faq)
- [リリースノート](./docs/release-notes-v0.3.1.md)
- [Roadmap](https://github.com/users/Pls-1q43/projects/1)
- [中文主页](./README.md)
- [English README](./README.en.md)

### Dibao が解決すること

時間順の RSS は正直ですが、未読が増えると壁のようになります。プラットフォーム型の推薦は便利ですが、読書履歴と発見ロジックを外部サービスに渡すことになります。Dibao はその中間を選びます。

- **購読元はあなたのもの**：明示的に追加した RSS / Atom だけを扱います。
- **読む順番を整える**：最新記事の山から、先に読む価値の高いものを上に出します。
- **理由を説明する**：トピック、ソース、鮮度、最近の読書フィードバックなど、推薦理由を確認できます。
- **データは手元に残る**：SQLite データベースはローカル、NAS、自宅サーバー、VPS の永続化フォルダに保存されます。
- **失敗を見える化する**：フィード更新失敗、provider 不通、索引作成の状態を画面で確認できます。

### できること

| ニーズ | Dibao の機能 |
| --- | --- |
| 未読が多すぎる | Recommended で今日読む記事を優先表示し、Latest で従来の時間順も残します。 |
| RSS を持ち運びたい | OPML のインポート / エクスポートに対応します。 |
| 推薦理由を知りたい | 記事ごとに、トピック、ソース、鮮度、フィードバックなどの理由を表示します。 |
| プラットフォームに閉じ込められたくない | Docker でセルフホストし、SQLite をローカルに保存します。 |
| 低コストで AI を使いたい | [SiliconFlow](https://cloud.siliconflow.cn/i/4wjbYmMH)、Gemini、Ollama、OpenAI-compatible embedding provider に対応します。 |
| スマートフォンで読みたい | PWA としてホーム画面に追加できます。 |

現在は、複数ユーザーのチーム利用、公式ホスティング、クラウド同期、SNS フォロー、コメント、購読外コンテンツの推薦、全文記事のオフライン保存は提供していません。

### Dibao を支援する

Dibao が役に立った場合は、Stripe から開発を支援できます。

[Stripe で Dibao を支援する](https://buy.stripe.com/4gM3cugQ01Zp6hBeiTdfG00)

### クイックインストール

Docker Compose での実行を推奨します。次の内容で `compose.yaml` を作成します。

```yaml
name: dibao

services:
  dibao:
    image: ghcr.io/pls-1q43/dibao:v0.3.1
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      DIBAO_HOST: 0.0.0.0
      DIBAO_PORT: "8080"
      DIBAO_DATABASE_PATH: /data/dibao.sqlite
      DIBAO_COOKIE_SECURE: "auto"
    volumes:
      - ./data:/data
```

起動します。

```bash
docker compose up -d
```

`http://localhost:8080` を開き、所有者アカウントのユーザー名とパスワードを作成します。その後、OPML をインポートするか、最初の RSS / Atom フィードを追加します。

現在のリポジトリからビルドする場合：

```bash
git clone https://github.com/Pls-1q43/Dibao.git
cd dibao
docker compose up --build -d
```

### 推奨 Provider

Dibao は AI provider なしでも使えます。Provider を設定すると、embedding によって推薦がより個人の読書傾向に近づきます。まずは Dibao をどこで動かすかで選びます。

| 実行環境 | 推奨 |
| --- | --- |
| ローカルの MacBook、Mac mini、Windows デスクトップ / ノート PC | まずはローカル Ollama。読書データを外に出さず、API コストもかかりません。推奨モデルは `bge-m3`、dimension は `1024`。 |
| 家庭用 NAS または低消費電力ミニ PC | CPU やメモリに余裕がなければ、[SiliconFlow](https://cloud.siliconflow.cn/i/4wjbYmMH) または Gemini を優先します。 |
| `4 vCPU / 8GB RAM` 以上の VPS | Ollama CPU でもバックグラウンド embedding は可能です。`bge-m3` を使い、初回索引には時間がかかる前提で運用します。 |
| `4 vCPU / 8GB RAM` 未満の VPS | [SiliconFlow](https://cloud.siliconflow.cn/i/4wjbYmMH) または Gemini を推奨します。小さな VPS で embedding backfill に CPU / RAM を使い切らないためです。 |

ローカル Ollama の推奨設定：

```bash
ollama pull bge-m3
```

| フィールド | 値 |
| --- | --- |
| Type | `Ollama` |
| Base URL | Docker Desktop で Dibao を動かし、Ollama をホスト側で動かす場合は `http://host.docker.internal:11434`。同じマシンで Docker なしに直接動かす場合は `http://127.0.0.1:11434`。 |
| Model | `bge-m3` |
| Dimension | `1024` |

`bge-m3` は、中国語、日本語、英語を含む多言語 RSS に向いており、Ollama から直接利用できます。より軽く速いローカル構成が必要な場合は、`nomic-embed-text` と dimension `768` を検討できます。

外部の無料 / 低コスト provider：

| Provider | 設定 |
| --- | --- |
| [SiliconFlow](https://cloud.siliconflow.cn/i/4wjbYmMH) | 推奨モデルは `BAAI/bge-m3`。無料で日次上限はなく、RPM / TPM のレート制限で運用されます。現在の L0 制限は 2,000 RPM、500,000 TPM です。<br>Type: `OpenAI-compatible`<br>Base URL: `https://api.siliconflow.cn/v1`<br>Model: `BAAI/bge-m3`<br>Dimension: `1024` |
| Gemini | Gemini embedding も無料枠があり、個人用の小さな RSS 環境に向いています。1 日あたりおよそ 1,000 リクエストを目安に計画してください。<br>Type: `OpenAI-compatible`<br>Base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`<br>Model: `gemini-embedding-001`<br>Dimension: `768` |

無料枠、価格、レート制限、利用可能地域は変更されることがあります。大量に使う前に、[Ollama bge-m3](https://ollama.com/library/bge-m3)、現在の [SiliconFlow embeddings docs](https://docs.siliconflow.cn/cn/api-reference/embeddings/create-embeddings)、[Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) を確認してください。

モデルや dimension を変更した場合、embedding は再生成が必要です。Dibao は読書データを保持しますが、異なるモデルのベクトルはそのまま混在できません。Provider が利用できない場合でも RSS リーダーとしては使えますが、推薦は基本的な並び順に戻ります。

### 日常的な使い方

1. OPML をインポートするか、RSS / Atom URL を追加します。
2. `Recommended` で優先して読む記事を確認し、`Latest` で従来の時間順も使います。
3. 保存、あとで読む、既読、興味なしを使って、次回以降の並び順を調整します。
4. 未読が溜まったら、すべて、24 時間前、7 日前、30 日前などの範囲で整理します。
5. フィード管理で失敗したフィードを確認し、再試行、グループ調整、OPML エクスポートを行います。

未読整理は読書操作であり、好みの正のフィードバックとしては扱われません。保存とあとで読むの記事も整理対象から外れます。

### PWA インストール

- Android Chrome / Edge：ブラウザメニューから「アプリをインストール」または「ホーム画面に追加」。
- iOS Safari：共有メニューから「ホーム画面に追加」。
- Desktop Chrome / Edge：アドレスバーのインストールボタン、またはブラウザメニューからインストール。

`localhost` / `127.0.0.1` では通常そのままインストールできます。LAN IP や公開ドメインで使う場合は HTTPS を推奨します。`DIBAO_COOKIE_SECURE=auto` は直接接続のプロトコルまたはリバースプロキシの `X-Forwarded-Proto` に応じて Cookie を自動設定します。

### バックアップとアップグレード

デフォルトでは、Dibao のデータは `compose.yaml` と同じ場所の永続化フォルダに保存されます。

```text
./data:/data
./data/dibao.sqlite
```

アップグレード前にバックアップすることを推奨します。

```bash
docker compose stop
tar czf dibao-data-backup.tgz -C data .
docker compose up -d
```

リリースイメージをアップグレードする場合は、`compose.yaml` の image tag を変更してから実行します。

```bash
docker compose pull
docker compose up -d
docker compose ps
```

データベース migration は起動時に自動実行されます。アップグレード後は `http://localhost:8080/api/system/health` を開き、`ok: true` が返ることを確認してください。

### ライセンス

Dibao は [Business Source License 1.1](./LICENSE.md)（`BUSL-1.1`）のもとで提供される source-available / fair-code / delayed open source プロジェクトです。BUSL-1.1 は Change Date の前は OSI 承認のオープンソースライセンスではありません。各公開リリースは、初回公開から 4 年後の Change Date に [Apache License 2.0](./LICENSE-APACHE-2.0.md)（`Apache-2.0`）へ自動的に切り替わります。

個人、家庭、非商用、研究、評価、学習、会社や組織の内部セルフホスト用途では、Dibao を無料で使用、変更、セルフホスト、本番利用できます。有償のデプロイ、コンサルティング、トレーニング、移行、運用支援も、顧客自身の環境、アカウント、または管理下のインフラに Dibao インスタンスを提供する形であれば許可されます。

有料ホスティング、SaaS、Managed Service、Cloud Service、ホワイトラベル、再販売、競合する商用製品、または Dibao / 改変版 Dibao を中核機能とする商用 RSS リーダー、情報フィード推薦サービス、AI 読書 / 要約サービス、コンテンツ集約サービス、ナレッジフロー製品には、別途商用ライセンスが必要です。商用ライセンスについては https://dibao.app を参照してください。正確な Release Date と Change Date は、対応する release tag に固定された `LICENSE.md` が基準です。

### FAQ

**AI provider なしで使えますか？**

はい。RSS の読書、OPML、検索、保存、あとで読む、フィード管理、基本的な並び替えは使えます。Provider は推薦をより賢くするための追加機能です。

**Dibao は購読していないコンテンツを推薦しますか？**

いいえ。推薦は、あなたが明示的に追加した RSS / Atom フィードの内側だけで行われます。

**データはどこに保存されますか？**

ローカルの `./data` フォルダを `/data` にマウントし、その中の SQLite データベースに保存されます。

**スマートフォンにインストールできますか？**

はい。Safari、Chrome、Edge から PWA としてインストールできます。localhost 以外で使う場合は HTTPS を推奨します。

**Provider のテストに失敗したら？**

Base URL、モデル名、dimension、API Key が一致しているか確認してください。SiliconFlow では `BAAI/bge-m3` と dimension `1024`、Gemini では `gemini-embedding-001` と dimension `768` から始めるのが無難です。

**LAN 内の HTTP でログイン状態が維持されません。**

`DIBAO_COOKIE_SECURE=auto` のままにし、リバースプロキシが正しい `X-Forwarded-Proto` を渡していることを確認してください。HTTP だけを使い、プロキシがそのヘッダーを渡せない場合は `false` を明示的に設定できます。

**フィード更新に失敗したら？**

フィード管理でエラー理由を確認してください。よくある原因は、フィード URL の失効、対象サイトによるアクセス拒否、XML 形式の問題、ネットワークタイムアウトです。

<details>
<summary>メンテナー / 開発者向け情報</summary>

主な環境変数：

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `DIBAO_HOST` | `0.0.0.0` | Server の listen address。 |
| `DIBAO_PORT` | `8080` | Server の listen port。 |
| `DIBAO_DATABASE_PATH` | `/data/dibao.sqlite` | SQLite database path。 |
| `DIBAO_COOKIE_SECURE` | `auto` | 直接接続のプロトコルまたは `X-Forwarded-Proto` から自動判定します。`true` / `false` の明示指定も可能です。 |
| `DIBAO_ALLOWED_ORIGINS` | 空 | 書き込みリクエストを許可する追加の信頼済みブラウザー Origin。複数値はカンマ区切りです。プロキシが Host を保持できない場合のみ使います。 |
| `DIBAO_BACKGROUND_JOBS` | `true` | `false` にすると background job runner を停止します。主にテスト用途です。 |
| `DIBAO_FETCH_TIMEOUT_MS` | `15000` | RSS、discover、full-content fetch の単一リクエスト timeout。 |
| `DIBAO_FETCH_FEED_MAX_BYTES` | `5242880` | RSS / discover response の最大読み取りバイト数。 |
| `DIBAO_FETCH_FULL_CONTENT_MAX_BYTES` | `3145728` | full-content fetch response の最大読み取りバイト数。 |

開発コマンド：

```bash
npm install
npm run build
npm run test
```

</details>

より詳しい製品説明とリリース情報は、[中文主页](./README.md) と [English README](./README.en.md) も参照してください。
