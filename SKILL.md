---
name: padeli:post-publish
description: "Post-publish pipeline for padeli.com. Refreshes internal link graph, retrofits cross-links across the corpus, checks Google indexing status, and submits for indexing if needed. Use after publishing listings or blog posts — ensures every published page is connected and visible to Google."
user-invocable: true
---

# Padeli Post-Publish

Run after publishing listings or blog posts on padeli.com. Ensures every published page is properly cross-linked to the rest of the site and visible to Google.

**Pipeline:** resolve post -> refresh page index -> retrofit cross-links (outbound + inbound) -> check indexing -> submit if needed -> report

**Prototype status:** First build, not yet tested at scale.

---

## Input Modes

### Mode 1: Single post

```
/padeli:post-publish https://padeli.com/listing/game4padel-richmond/
/padeli:post-publish 11735
```

Accepts a full URL or a WordPress post ID.

### Mode 2: Batch by date

```
/padeli:post-publish all since 2026-05-15
```

Processes every listing and post published since that date.

### Mode 3: Batch by country

```
/padeli:post-publish all AE
/padeli:post-publish all GB
```

Processes all recently published listings for a country.

### Mode 4: Check indexing only

```
/padeli:post-publish check https://padeli.com/listing/game4padel-richmond/
```

Just checks Google indexing status — no linking changes.

---

## Execution Steps

### Step 1: Parse Input

Determine the mode from the user's message:
- URL or number -> single mode
- "all since YYYY-MM-DD" -> batch by date
- "all XX" (country code) -> batch by country
- "check URL" -> indexing check only

### Step 2: Refresh Page Index

Always run this first — it rebuilds the link graph from all published content:

```bash
node -e "
const { refreshPageIndex } = require('./linker');
refreshPageIndex().then(r => console.log(JSON.stringify(r, null, 2)));
"
```

### Step 3: Run Post-Publish Pipeline

**Single post:**

```bash
node -e "
const { postPublishSingle } = require('./post-publish');
postPublishSingle('{URL_OR_ID}').then(r => console.log(JSON.stringify(r, null, 2)));
"
```

**Batch:**

```bash
node -e "
const { postPublishBatch } = require('./post-publish');
postPublishBatch({ since: '{DATE}' }).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

```bash
node -e "
const { postPublishBatch } = require('./post-publish');
postPublishBatch({ country: '{CC}' }).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

**Check only:**

```bash
node -e "
const { checkIndexStatus } = require('./post-publish');
checkIndexStatus('{URL}').then(r => console.log(JSON.stringify(r, null, 2)));
"
```

### Step 4: Review Results

Present results to the user in this format:

**Single post:**
```
POST-PUBLISH: {Title}
URL: {url}
Post ID: {id}

Links:
  Outbound added: {N} (links from this post to others)
  Inbound added: {N} (links from other posts to this one)

Indexing:
  Status: {INDEXED / NOT_INDEXED / PARTIAL}
  Last crawled: {date or 'never'}
  Submitted: {yes/no}

Warnings:
- {any issues}
```

**Batch:**
```
POST-PUBLISH BATCH: {N} posts processed

Links added: {total outbound + inbound}
Already indexed: {N}
Submitted for indexing: {N}
Errors: {N}

Details:
| Post | Links Added | Index Status | Submitted |
|------|-------------|--------------|-----------|
| ...  | ...         | ...          | ...       |
```

---

## What This Does NOT Do

- Does NOT run the full 67-point QC (use `/padeli:audit-content` for that)
- Does NOT modify post content beyond adding/updating internal links
- Does NOT change post status (publish/draft/trash)
- Does NOT touch meta fields, Yoast, schema, or images

This is specifically about **connectivity** (links) and **visibility** (indexing).

---

## Dependencies

- Node.js v24+ (native fetch, no npm packages)
- All modules bundled at repo root:
  - `post-publish.js` — orchestrator (this skill's engine)
  - `linker.js` — page index builder + internal link engine
  - `retrofit-linker.js` — corpus-wide cross-linking scanner
  - `wp-client.js` — WP REST API client
  - `config.js`, `utils.js` — shared helpers
- Env vars (set in `~/.zshrc`):
  - `PADELI_WP_USER` / `PADELI_WP_APP_PASSWORD` — WP auth
  - GSC OAuth token at `~/.config/gcloud/padeli-oauth-token.json` (for indexing API)

---

## CLI Usage

Can also be run directly from Terminal:

```bash
cd ~/Projects/padeli-post-publish
node post-publish.js single <url_or_id>
node post-publish.js batch --since 2026-05-15
node post-publish.js batch --country AE
node post-publish.js check <url>
node post-publish.js submit <url>
```
