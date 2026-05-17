# Padeli Post-Publish

Post-publish orchestrator for [padeli.com](https://padeli.com). Run after
publishing listings or blog posts to ensure every new page is properly
cross-linked and visible to Google.

## Pipeline

1. **Resolve post** — fetch the just-published WP entry by URL or ID
2. **Refresh page index** — rebuild the corpus map so the linker knows about the new page
3. **Retrofit cross-links** — scan related pages, add inbound links to the new one
4. **Check indexing** — query Google Search Console for indexing status
5. **Submit for indexing** — request indexing via the Indexing API if needed
6. **Report** — summary of links added, indexing status, follow-up actions

## Quick Start

```bash
git clone https://github.com/rcspence1/padeli-post-publish.git
cd padeli-post-publish

# Required env in ~/.zshrc
export PADELI_WP_USER="..."
export PADELI_WP_APP_PASSWORD="..."

# Required for the indexing step:
# OAuth token at ~/.config/gcloud/padeli-oauth-token.json

# Single post / listing
node post-publish.js single https://padeli.com/listing/pure-padel-darlington/

# Batch — all recently published posts
node post-publish.js batch --since 7days
```

Full skill spec: [`SKILL.md`](./SKILL.md).

## Requirements

- Node.js v24+ (native `fetch`, zero external deps)
- WordPress REST API credentials for padeli.com
- Google Search Console OAuth token (for indexing API)
