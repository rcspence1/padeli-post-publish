# Post-Publish Engine — State Map (Phase A)
**Date:** 2026-06-12 · **Repo:** `~/Projects/padeli-post-publish/`
**Spec:** `website-listings-sop/LINKING-ARCHITECTURE-DECISION-2026-06-12.md`

This is the read-only "current behaviour" picture, written BEFORE any Phase-B edits.
Note: the 3 files (`retrofit-linker.js`, `post-publish.js`, `linker.js`) already had
**uncommitted** working-tree changes when I arrived — those changes are the prototype-bug
fixes described below. They were never committed. I am folding them into my commit.

---

## 1. retrofit-linker.js — inbound vs outbound, and CPT routing

**Verdict: it applies INBOUND links only. Outbound is NOT done here.**

Trace of `retrofitLinks(newPostSlug)`:
1. `fetchPostBySlug(slug)` → resolves the NEW page (checks `/posts` then `/listing`, stamps `.type`).
2. `fetchCorpus()` → pulls the whole corpus (see §4).
3. `scanCorpus(newPost, corpus)` → for **each existing corpus page**, calls
   `classifyRelationship(newPost, existingPost)` and `findMentionOpportunities(newPost, existingPost)`.
   The opportunity search looks for the **new page's key terms inside the existing page's body**, and
   proposes editing the **existing** page to add a link → new page. That is **inbound** (existing → new).
4. `generateProposal(existingPost, opp, newPost)` → records `existing_post` (the page to be edited,
   with `post_type`) and `new_post` (the link target).
5. `applyProposals()` → for each approved proposal, routes the write by
   `existing_post.post_type`: `'listing' → /wp/v2/listing/{id}`, else `/wp/v2/posts/{id}`.
   **This CPT routing is correct** (was hardcoded to `/posts/` in the original prototype; the
   working-tree fix routes per-CPT). It fetches `?context=edit` for raw content and
   `replaceUnlinkedText()` swaps the first unlinked occurrence of the anchor.

There is **no outbound pass** in retrofit-linker. Outbound (new page → existing pages) is the job of
`linker.js::applyInternalLinks`, which runs inside create-listing / produce-article at build time.
`post-publish.js` Step 3 explicitly logs "Outbound linking handled by initial publish pipeline" and
does not run an outbound pass.

**Implication for the decision doc:** retrofit-linker is the INBOUND engine. Good — that is the
structurally-required half. But today it only ever links **into the new page**; it does not yet make
the new page (esp. a blog) link **out to region hubs / flagship clubs**. That is the Phase-B gap.

---

## 2. post-publish.js — indexing step + the 3 prototype bugs

### Indexing step
- `checkIndexStatus(url)` → **GSC URL Inspection API** (`searchconsole.googleapis.com/v1/urlInspection/index:inspect`).
  This is the CORRECT read-only status check. Returns INDEXED / NOT_INDEXED / PARTIAL.
- `submitForIndexing(url)` → in the working tree this is **already a no-op** with a clear comment:
  the Google **Indexing API** (`indexing.googleapis.com/v3/urlNotifications:publish`) only works for
  `JobPosting` / `BroadcastEvent`, so submitting listing/blog URLs there is the wrong tool. The
  original prototype called it; the uncommitted fix replaced it with a no-op that returns a message
  pointing operators to XML sitemap + GSC URL Inspection + manual Request-Indexing.
  **Status: already fixed (uncommitted). Matches the spec.**

### The 3 prototype bugs (tasks.md @724be408)
| Bug | State |
|---|---|
| (a) auto-approve high+med-confidence proposals | **FIXED (uncommitted)** — `retrofitLinks` step 5 flips `high`/`medium` `proposed→approved`; `low` stays for manual review. |
| (b) corpus extended to `/listing` + `applyProposals` writes to correct CPT | **FIXED (uncommitted)** — `fetchCorpus` now loops `['posts','listing']` and stamps `.type`; `applyProposals` routes by `existing_post.post_type`. |
| (c) `DEFAULT_INDEX_PATH` | **FIXED (uncommitted)** in `linker.js` — `resolveDefaultIndexPath()` checks `PADELI_PAGE_INDEX_PATH` env → in-repo `../data/page_index.json` → `PADELI_PROJECT_DIR/data/page_index.json`. (page_index.json does NOT live in this repo; it lives in padeli-notion, where `refreshPageIndex()` rebuilds it. The resolver finds it via `PADELI_PROJECT_DIR`.) |

So **all 3 prototype bugs + the indexing-tool issue were already fixed in the working tree but never committed.** My job is to commit them and add the Phase-B geo/region features on top.

### Indexing-API submit: still flagged
`submitForIndexing` is a no-op (good). `post-publish.js` Step 5 still *calls* it and pushes a warning
when status is NOT_INDEXED — that warning text correctly explains the submit is skipped. Effectively
indexing is now a **read-only STATUS check** plus a no-op submit. This satisfies the spec ("make
indexing a read-only STATUS check and clearly flag the submit as removed/disabled").

---

## 3. classifyRelationship — matching signals

Current signals (in order):
1. **Pillar** match (`pillar_slug`/`pillar` equal) → `pillar-child` / `parent-child` / `sibling`.
2. **Category** overlap → `topical`.
3. **Tag** overlap → `topical`.
4. **Slug-word** overlap (≥2 shared 4+char words) → `topical`.
5. else `none`.

**Confirmed: NO geo/region signal.** A "best padel in Dubai" blog has no preference for Dubai
listings or the Dubai region hub beyond incidental slug-word overlap. This is Phase-B item 1.

---

## 4. fetchCorpus — what it pulls

`fetchCorpus()` loops `['posts','listing']` and pulls `status=publish`, stamping `.type`.
**It does NOT fetch the `region` taxonomy archives** (`/clubs/{cc}/{city}/`). Region hubs are a
taxonomy archive, not a CPT, so they are invisible as link targets today. Phase-B item 2.

### Region taxonomy reality (verified live, 2026-06-12)
- Taxonomy slug: **`region`**, rest_base `region`, attached to `listing` + `tournament`.
- Each term's `link` field is already the live hub URL, e.g.
  `united-kingdom → /clubs/gb/`, `dubai → /clubs/ae/dubai/`, `london → /clubs/gb/london/`,
  `bali → /clubs/id/bali/`. So I can use `term.link` directly — no URL construction needed.
- Terms carry `count` (listings in that region) → use it to pick **flagship** city hubs and to rank.
- Hierarchy: country (parent=0) → home-nation/state (e.g. england 804) → county → city. City-level
  terms are the ones whose link matches `/clubs/{cc}/{city}/` (3 path segments after domain).

### page_index.json reality
- Lives in **padeli-notion** (`data/page_index.json`, 155 pages + 554 listings, updated 2026-05-27),
  NOT in this repo. `refreshPageIndex()` rebuilds it from WP.
- Each listing entry's `url` already carries the geo-nested path
  (e.g. `/coaching/gb/manchester/maria-herrera/`, `/clubs/{cc}/{city}/{slug}/`), so `{cc}/{city}`
  can be parsed straight from the URL — no extra meta fetch needed for city/country inference.

---

## 5. The rival linker (padeli-notion/lib/wp-payload.js::injectInternalLinks)

- Called once from `buildPayload` (line 606): `content = injectInternalLinks(content, venueName, opts)`.
- Crude logic: `title.toLowerCase().includes(city)` to find same-city listings + "padel" posts,
  drops one "Looking for more padel options…" paragraph before the schema block.
- This is the confirmed **divergence**: a second, dumber linking brain that runs at create time and
  can double-link / collide with the post-publish engine. Phase-B item 6 neutralises it (no-op, with
  a comment pointing to the decision doc), without touching the rest of `buildPayload`.

---

## Summary: already-working vs to-build
**Already working (committing the uncommitted fixes):**
- Inbound retrofit with correct per-CPT writes.
- Corpus = published posts + listings.
- Auto-approve high+med proposals.
- DEFAULT_INDEX_PATH resolver.
- Indexing = read-only GSC status check; submit is a safe no-op (correct tool guidance).
- BPA publish-readiness gate on listings.

**To build (Phase B):**
1. Geo/region signal in `classifyRelationship`.
2. Region-hub pages as link targets (from `region` taxonomy `link`).
3. Keep listing→listing OUT of body (Listeo "Other Clubs Near Me" owns that).
4. (indexing already correct — leave as read-only status check.)
5. (3 prototype bugs already fixed — just commit.)
6. Neutralise `injectInternalLinks` in padeli-notion.
