<p align="center">
  <img src="./apps/web/public/logo-192.png" width="96" height="96" alt="Dibao logo" />
</p>

<h1 align="center">邸报 Dibao</h1>

<p align="center">
  A source-available, fair-code, self-hostable RSS recommendation reader.
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

## English

Dibao is a **self-hosted RSS reader, AI RSS reader, personal news reader, OPML reader, local-first recommendation system, and PWA reading app** for people who still want to own their sources.

You choose the RSS / Atom feeds. Dibao ranks, deduplicates, searches, and explains articles only inside those feeds. It does not become another content platform, social network, or cloud reading service.

Quick links:

- [Why Dibao](#why-dibao)
- [What You Get](#what-you-get)
- [Support Dibao](#support-dibao)
- [Quick Install](#quick-install)
- [Recommended Providers](#recommended-providers)
- [Backup And Upgrade](#backup-and-upgrade)
- [License](#license)
- [FAQ](#faq)
- [Release notes](./docs/release-notes-v0.3.1.md)
- [Roadmap](https://github.com/users/Pls-1q43/projects/1)
- [Chinese home page](./README.md)

### Why Dibao

Chronological RSS is honest, but it can become impossible to scan. Platform feeds are convenient, but they move your reading data and discovery logic into someone else's system. Dibao keeps the good part of RSS while adding a recommendation layer you can inspect.

- Your subscriptions stay under your control.
- Recommendations only happen inside your own feeds.
- Each recommendation can show human-readable reasons.
- The SQLite database stays in your local persistent folder, NAS, home server, or VPS.
- Provider failures, feed errors, and indexing work are visible and recoverable.

### What You Get

| Need | Dibao |
| --- | --- |
| Too many unread articles | Recommended view ranks today's queue; Latest remains available. |
| Keep RSS portable | OPML import and export. |
| Understand recommendations | Article-level explanation for topic, source, freshness, and feedback signals. |
| Avoid platform lock-in | Self-hosted Docker deployment with local SQLite storage. |
| Use low-cost AI | Works with SiliconFlow, Gemini, Ollama, and OpenAI-compatible embedding providers. |
| Read on mobile | Installable PWA with app-shell caching. |

Dibao does not provide multi-user teams, hosted sync, social following, comments, platform-wide recommendations, or offline full-article storage.

### Support Dibao

If Dibao is useful to you, you can support ongoing development through Stripe:

[Support Dibao on Stripe](https://buy.stripe.com/4gM3cugQ01Zp6hBeiTdfG00)

### Quick Install

Create `compose.yaml`:

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

Start Dibao:

```bash
docker compose up -d
```

Open `http://localhost:8080`, create the owner login, then import OPML or add your first RSS / Atom feed.

To build from source:

```bash
git clone https://github.com/Pls-1q43/Dibao.git
cd dibao
docker compose up --build -d
```

### Recommended Providers

Dibao works without an AI provider, but embeddings make recommendations more personal. Choose based on where you run Dibao:

| Deployment | Recommendation |
| --- | --- |
| Local MacBook, Mac mini, or Windows desktop/laptop | Use local Ollama first. It keeps reading data on the machine and avoids API cost. Recommended model: `bge-m3`; dimension: `1024`. |
| Home NAS or low-power mini PC | Prefer [SiliconFlow](https://cloud.siliconflow.cn/i/4wjbYmMH) or Gemini unless the CPU is close to desktop-class and memory is comfortable. |
| VPS with at least `4 vCPU / 8GB RAM` | Ollama CPU can work for background embedding. Use `bge-m3`, and expect initial indexing to take time. |
| VPS below `4 vCPU / 8GB RAM` | Use [SiliconFlow](https://cloud.siliconflow.cn/i/4wjbYmMH) or Gemini. Small VPS instances should not spend their limited CPU/RAM on embedding backfill. |

Local Ollama settings:

```bash
ollama pull bge-m3
```

| Field | Value |
| --- | --- |
| Type | `Ollama` |
| Base URL | `http://host.docker.internal:11434` when Dibao runs in Docker Desktop and Ollama runs on the host; `http://127.0.0.1:11434` when both run directly on the same machine |
| Model | `bge-m3` |
| Dimension | `1024` |

`bge-m3` is the default local recommendation because it is not oversized, works well for multilingual RSS, and is available directly from Ollama. If you want a lighter and faster local option, use `nomic-embed-text` with dimension `768`.

External low-cost providers:

| Provider | Settings |
| --- | --- |
| [SiliconFlow](https://cloud.siliconflow.cn/i/4wjbYmMH) | Recommended model: `BAAI/bge-m3`. It is free, has no daily quota, and is rate-limited by RPM / TPM. Current L0 limits are 2,000 RPM and 500,000 TPM.<br>Type: `OpenAI-compatible`<br>Base URL: `https://api.siliconflow.cn/v1`<br>Model: `BAAI/bge-m3`<br>Dimension: `1024` |
| Gemini | Gemini embedding is also free and works well for a small personal RSS setup. Plan around the free tier's roughly 1,000 requests per day.<br>Type: `OpenAI-compatible`<br>Base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`<br>Model: `gemini-embedding-001`<br>Dimension: `768` |

Free tiers, pricing, and regional availability can change. Check [Ollama bge-m3](https://ollama.com/library/bge-m3), the current [SiliconFlow embeddings docs](https://docs.siliconflow.cn/cn/api-reference/embeddings/create-embeddings), and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) before depending on a provider for heavy use.

### Backup And Upgrade

Default data path:

```text
./data:/data
./data/dibao.sqlite
```

Back up before upgrading:

```bash
docker compose stop
tar czf dibao-data-backup.tgz -C data .
docker compose up -d
```

Upgrade:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Health check: `http://localhost:8080/api/system/health`.

### License

Dibao is source-available, fair-code, and self-hostable under the [Business Source License 1.1](./LICENSE.md) (`BUSL-1.1`). BUSL-1.1 is not an OSI-approved open-source license before the Change Date. Each released version becomes open source under [Apache License 2.0](./LICENSE-APACHE-2.0.md) (`Apache-2.0`) after its Change Date.

Personal, household, non-commercial, research, evaluation, learning, and internal company or organization self-hosting are free to use in production. Paid deployment, consulting, training, migration, and operational support are allowed when the customer receives a Dibao instance in the customer's own environment, account, or controlled infrastructure.

Paid hosting, SaaS, Managed Service, Cloud Service, white-label distribution, resale, competing commercial products, or commercial services where Dibao or modified Dibao is a core capability require a separate commercial license. Contact https://dibao.app for commercial licensing. The exact Release Date and Change Date are defined by the frozen `LICENSE.md` in the corresponding release tag; the `main` branch represents the current development version.

### FAQ

**Can I use Dibao without an AI provider?**

Yes. You still get RSS reading, OPML, search, saved articles, read-later, feed management, and baseline sorting.

**Will Dibao recommend content outside my subscriptions?**

No. Recommendations stay inside your RSS / Atom feeds.

**Where is my data stored?**

In the SQLite database under the local `./data` folder mounted at `/data`.

**Can I install it on my phone?**

Yes, as a PWA from Safari, Chrome, or Edge. HTTPS is recommended outside localhost. The default `DIBAO_COOKIE_SECURE=auto` follows the direct protocol or the reverse proxy's `X-Forwarded-Proto` header.
