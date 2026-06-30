# Listing Writer 🪄

A free, open-source web app for resellers. **Dump in a pile of item photos →
it sorts them into separate items → writes a full eBay listing for each →
posts them to eBay.** Runs as your own private website, self-hosted with Docker
(e.g. on [Coolify](https://coolify.io)); works on your computer and your phone.

It's **bring-your-own-keys**: you plug in your own Anthropic (AI) key and your
own eBay developer keys, so you're in full control and there's no middleman.

---

## What it does

- 📸 Upload a whole batch of photos at once
- 🔀 Auto-sorts them into separate items (group → verify → un-split)
- 🏷️ Assigns bin/SKU codes so you can find items later (e.g. `K42-A`, `K42-B`)
- 🤖 Writes a title, description, item specifics, condition, and suggested price
- ✍️ Everything is editable before you post
- 🚀 Posts straight to eBay — one item or the whole batch
- 📋 Or export everything as CSV / JSON
- 🔒 Your keys live in environment variables, never in the code

---

## What you'll need (all free to start)

1. **An Anthropic API key** — the AI that writes listings. Get one at
   <https://console.anthropic.com/> (you pay Anthropic per use; pennies per item).
2. **An eBay developer keyset** — to post listings. Free at
   <https://developer.ebay.com/>. You'll need the **App ID**, **Cert ID**, and a
   **RuName** (explained below). *Only needed for posting — sorting and writing
   work without it.*
3. **Somewhere to run it** — a server with [Docker](https://docs.docker.com/get-docker/).
   The easiest path is a self-hosted PaaS like [Coolify](https://coolify.io) on a
   cheap VPS, which gives you a deploy-from-GitHub workflow and automatic HTTPS.
4. **Node.js** if you want to run it locally for development —
   <https://nodejs.org/> (the "LTS" version).

---

## 🚀 Quick Start with Coolify (recommended)

[Coolify](https://coolify.io) is a free, open-source, self-hosted platform —
think "your own Vercel/Heroku" on a server you control. Install it on any VPS
(it has a one-line installer), then:

1. **Add this repository** as a new resource → *Public/Private Git Repository*.
2. **Set the Build Pack to `Dockerfile`** — the included `Dockerfile` builds a
   self-contained image (Vite-built SPA served by a Hono server), and the
   built-in `/api/health` endpoint lets Coolify monitor the container.
3. **Add the environment variables** (see the table below) in
   **Coolify → your resource → Environment Variables**. At minimum set:
   - `ANTHROPIC_API_KEY` — your Anthropic key (starts with `sk-ant-`).
   - `APP_SECRET` — any access code you make up. A deployed app **won't run
     without this**: it stops strangers from spending your Anthropic credits,
     and every AI action returns an error until it's set.
   - (Add the eBay variables later, when you're ready to post.)
4. **Set a domain** and let Coolify provision HTTPS, then **Deploy**. Set
   `APP_URL` to that public domain.

Bookmark your app on your computer and add it to your phone's home screen. You
can start sorting and writing listings immediately.

> Prefer a different host? Anything that runs a Docker image works — CapRover,
> Dokku, Railway, Fly.io, or a plain `docker compose up` on a VPS behind a
> reverse proxy. There are no platform-specific dependencies.

---

## Run locally with Docker

```bash
git clone https://github.com/monkeyx-net/hahm-ebay-lister.git
cd hahm-ebay-lister
cp .env.example .env.local        # then edit and set ANTHROPIC_API_KEY=sk-ant-...
./deploy.sh                       # builds the image and starts it on :3000
```

`./deploy.sh` wraps `docker compose build` + `docker compose up -d`. Open
<http://localhost:3000>. To view logs: `docker compose logs -f`. To stop:
`docker compose down`.

## Run locally for development (no Docker)

```bash
git clone https://github.com/monkeyx-net/hahm-ebay-lister.git
cd hahm-ebay-lister
npm install
cp .env.example .env.local        # then edit and set ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Open <http://localhost:5173> (the Vite dev server; it proxies `/api` to the Hono
server on `:3000`, which `npm run dev` starts alongside it). You can sort and
write listings right away. (eBay posting needs the eBay setup below + a deployed URL.)

---

## Set up eBay posting (optional, for the "Post to eBay" button)

1. At <https://developer.ebay.com/> create a **Production keyset**. Note the
   **App ID (Client ID)** and **Cert ID (Client Secret)**.
2. Under that keyset → **User Tokens** → **Add eBay Redirect URL (RuName)**.
   Set, using your deployed URL:
   - **Auth accepted URL:** `https://your-app.example.com/api/ebay/callback`
   - **Auth declined URL:** `https://your-app.example.com/?ebay=declined`
   - **Privacy policy URL:** `https://your-app.example.com/privacy`
   - Choose **OAuth** (not Auth'n'Auth).
3. Copy the generated **RuName** — the short identifier (like `Name-XXXX-XXXX-XXXX`),
   **not** the long "eBay Production Sign In (OAuth)" URL shown on the same page.
4. Put all the values into your environment variables (below) and redeploy.
5. On the live site, click **Connect eBay**, approve on eBay, and paste the URL
   from eBay's confirmation page back into the app. Done (lasts ~18 months).

> **"Marketplace account deletion" compliance.** When you create a production
> keyset, eBay flags it **"not compliant"** and asks for a *Marketplace account
> deletion/closure notification endpoint*. This app stores **no** eBay user data on
> a server — your token lives only in an encrypted cookie in your own browser — so
> you don't need an endpoint. Instead, take eBay's exemption: in the developer
> portal under *Alerts & Notifications → Marketplace account deletion*, toggle ON
> **Exempted from Marketplace Account Deletion / Not persisting eBay data** and
> submit it. (Describe your setup honestly — eBay penalizes false exemptions.) Do
> this **before** your first production API call. Only if eBay won't accept the
> exemption do you need to host an endpoint.

---

## Environment variables

| Variable | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key (writes the listings) |
| `APP_SECRET` | ✅ for deployed apps | Access code protecting the AI endpoints so strangers can't spend your Anthropic credits. **A deployed (production) app fails closed without it** — every AI route returns an error until it's set. Asked for once per device, then remembered. Optional only for local dev. |
| `EBAY_CLIENT_ID` | for posting | eBay App ID |
| `EBAY_CLIENT_SECRET` | for posting | eBay Cert ID |
| `EBAY_RU_NAME` | for posting | Your eBay RuName — the short `Name-XXXX-XXXX-XXXX` identifier, **not** the long "Sign In (OAuth)" URL |
| `SESSION_SECRET` | for posting | Random string to encrypt your eBay token. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `APP_URL` | for posting | Your deployed URL, e.g. `https://your-app.example.com` |
| `EBAY_MARKETPLACE_ID` | optional | eBay site to list on. Defaults to `EBAY_GB` (UK). Use `EBAY_US`, `EBAY_DE`, etc. for other sites. |
| `EBAY_CATEGORY_TREE_ID` | optional | Category tree for the site. Defaults to `3` (UK). US = `0`, DE = `77`. Keep consistent with the marketplace. |
| `EBAY_SITE_ID` | optional | Trading-API site id used for photo upload. Defaults to `3` (UK). US = `0`. |
| `EBAY_CURRENCY` | optional | ISO currency the offers are priced in. Defaults to `GBP`. e.g. `USD`, `EUR`. |
| `EBAY_LOCALE` | optional | Locale sent as Accept/Content-Language. Defaults to `en-GB`. e.g. `en-US`, `de-DE`. |
| `EBAY_ITEM_BASE_URL` | optional | Base URL for "View listing" links. Defaults to `https://www.ebay.co.uk/itm/`. |
| `EBAY_LOCATION_COUNTRY` | optional | Country (ISO 3166 alpha-2) for the auto-created inventory location. Defaults to `GB`. |
| `EBAY_LOCATION_POSTAL_CODE` | optional | Your postcode (only used once to create an eBay inventory location). Defaults to a UK postcode. |
| `EBAY_DEFAULT_PACKAGE_WEIGHT_OZ` | optional | Default package weight in ounces (16 = 1 lb) sent to eBay so **calculated-shipping** policies can publish (avoids eBay error 25020). Editable per listing on eBay. |
| `EBAY_DEFAULT_PACKAGE_LENGTH_IN` / `_WIDTH_IN` / `_HEIGHT_IN` | optional | Default package dimensions in inches (defaults 12 × 9 × 3). |

**Never commit real keys.** `.env.local` is gitignored; production keys live in
your host's environment settings (e.g. Coolify → Environment Variables) only.

---

## Category IDs and your marketplace

eBay category IDs are **per-marketplace** — the UK category tree is id `3`, the
US tree is `0`, Germany `77`, and so on. Some IDs coincide between sites but many
don't, so a leaf that is correct on eBay.com can be the wrong category (or not a
leaf at all) on eBay.co.uk.

In normal operation this is handled for you: when an item is published the app
asks eBay's **Taxonomy API** for the correct leaf category for the active tree
(`EBAY_CATEGORY_TREE_ID`) from the listing's title + hint. The static
`CATEGORY_MAP` / `LEAF_FALLBACKS` tables in `lib/ebay/publish.ts` are only an
**offline fallback** for the rare case where that lookup is unavailable.

Those fallback tables ship seeded with **US** IDs. To regenerate them for your
marketplace (e.g. UK), run the generator — it resolves every category against
eBay's Taxonomy API for whatever tree you're configured for and prints a
ready-to-paste block:

```bash
EBAY_CLIENT_ID=...      \
EBAY_CLIENT_SECRET=...  \
EBAY_RU_NAME=...        \
EBAY_CATEGORY_TREE_ID=3 \   # 3 = UK (default), 0 = US, 77 = DE …
EBAY_MARKETPLACE_ID=EBAY_GB \
npm run refresh:categories
```

Review the resolved IDs in the output, then paste the `CATEGORY_MAP` and
`LEAF_FALLBACKS` blocks into `lib/ebay/publish.ts` and commit. Re-run this
whenever you change `EBAY_MARKETPLACE_ID` / `EBAY_CATEGORY_TREE_ID`. (The script
only **prints** the new tables — it never edits the source for you, so you stay
in control of what gets committed.)

---

## How it works (for the curious)

```mermaid
flowchart TD
    U["🧑 You — browser / phone<br/>(photos resized client-side)"]
    subgraph V["Your self-hosted app (React + Hono in Docker)"]
        S["/api/sort<br/>group → verify → un-split"]
        A["/api/analyze<br/>write one listing"]
        E["/api/ebay/*<br/>connect + publish"]
        C[["🔒 encrypted cookie<br/>(eBay refresh token)"]]
    end
    AN["Anthropic API<br/>(your key)"]
    EB["eBay APIs<br/>(your developer keys)"]

    U -->|"all photos (thumbnails)"| S
    U -->|"one item's photos"| A
    U -->|"post listing"| E
    S --> AN
    A --> AN
    E <--> C
    E -->|"upload photos · inventory → offer → publish"| EB
```

- **Frontend** (`app/` + `src/`): the upload → sort → review → write → post
  wizard — a React SPA built by Vite. Photos are shrunk in your browser before upload.
- **Server** (`server/`): a Hono server that hosts the `/api/*` routes and serves
  the built SPA from a single port.
- **`/api/sort`**: groups photos into items (AI), with verify + un-split passes.
- **`/api/analyze`**: writes a listing for one item from its photos.
- **`/api/ebay/*`**: OAuth connect (encrypted-cookie token) + the
  inventory→offer→publish flow, with recovery for eBay's category/aspect quirks.
- **`/api/health`**: unauthenticated liveness probe for container health checks.
- **Stack**: React + Vite (client) and Hono on Node (server), TypeScript
  throughout, packaged as a single Docker image. Nothing is stored server-side;
  photos are used to build listings and discarded.

---

## Costs

- **Anthropic**: a few cents per item (sorting + writing). You set your own key.
- **eBay**: normal eBay selling fees apply to listings you post.
- **Hosting**: a small VPS (a few dollars a month) is plenty for personal use;
  Coolify itself is free and open source.

---

## License

**Functional Source License (FSL-1.1-MIT)** — see [LICENSE](LICENSE).

In plain English: **free to use, modify, and self-host** — including for your
own reselling business. The one thing you *can't* do is sell this software or
offer it as a competing paid product/service. Two years after each release, that
restriction lifts and it becomes plain MIT. Use it, fork it, share it — just
don't resell it.
