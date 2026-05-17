/**
 * Post-Publish Orchestrator for Padeli
 *
 * Runs post-publish operations on padeli.com listings and blog posts:
 *   1. Resolve WP post (by URL or ID)
 *   2. Refresh page index
 *   3. Retrofit linking (outbound + inbound)
 *   4. Google indexing check via GSC URL Inspection API
 *   5. Submit for indexing if not indexed
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { SITE_URL, wpGet } = require('./wp-client');
const { refreshPageIndex } = require('./linker');
const { retrofitLinks, fetchCorpus, scanCorpus } = require('./retrofit-linker');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GSC_TOKEN_PATH = path.join(process.env.HOME || '', '.config/gcloud/padeli-oauth-token.json');
const GSC_SITE_URL = 'https://padeli.com/';

// ---------------------------------------------------------------------------
// OAuth — same pattern as content-auditor.js
// ---------------------------------------------------------------------------

/**
 * Load OAuth token and get a fresh access token.
 * @returns {Promise<string|null>} access token or null if not configured
 */
async function getAccessToken() {
  if (!fs.existsSync(GSC_TOKEN_PATH)) return null;
  const token = JSON.parse(fs.readFileSync(GSC_TOKEN_PATH, 'utf8'));
  if (!token.client_id || !token.client_secret || !token.refresh_token) return null;

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }).toString();
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error(parsed.error || 'No access token'));
        } catch { reject(new Error('Bad token response')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Make an HTTPS request with JSON body and auth header.
 * @param {string} url
 * @param {string} accessToken
 * @param {object} [body] - POST body (if provided, sends POST; otherwise GET)
 * @returns {Promise<object>}
 */
function apiRequest(url, accessToken, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    if (body) {
      const jsonBody = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(jsonBody);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(data) }); }
        catch { reject(new Error(`Bad response: ${data.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// WP Post Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a WP post by URL or numeric ID.
 * Checks both /wp/v2/posts and /wp/v2/job-listings (listing CPT).
 *
 * @param {string|number} urlOrId - Full URL or WP post ID
 * @returns {Promise<object>} WP post object
 */
async function resolvePost(urlOrId) {
  // Numeric ID
  if (!isNaN(urlOrId)) {
    const id = Number(urlOrId);
    // Try posts first, then listings
    try {
      const post = await wpGet(`/wp-json/wp/v2/posts/${id}?context=edit`);
      if (post && post.id) return post;
    } catch { /* not a post */ }

    try {
      const listing = await wpGet(`/wp-json/wp/v2/listing/${id}?context=edit`);
      if (listing && listing.id) return listing;
    } catch { /* not a listing */ }

    throw new Error(`No post or listing found with ID ${id}`);
  }

  // URL — extract slug
  const urlStr = String(urlOrId).replace(/\/+$/, '');
  const slug = urlStr.split('/').filter(Boolean).pop();
  if (!slug) throw new Error(`Could not extract slug from URL: ${urlOrId}`);

  // Search posts by slug
  try {
    const posts = await wpGet(`/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&context=edit`);
    if (Array.isArray(posts) && posts.length > 0) return posts[0];
  } catch { /* not a post */ }

  // Search listings by slug
  try {
    const listings = await wpGet(`/wp-json/wp/v2/listing?slug=${encodeURIComponent(slug)}&context=edit`);
    if (Array.isArray(listings) && listings.length > 0) return listings[0];
  } catch { /* not a listing */ }

  throw new Error(`No post or listing found for: ${urlOrId}`);
}

// ---------------------------------------------------------------------------
// Google Indexing Status
// ---------------------------------------------------------------------------

/**
 * Check Google indexing status for a URL via GSC URL Inspection API.
 *
 * @param {string} url - Full page URL
 * @returns {Promise<object>} { status, lastCrawled, coverageState, verdict, robotsTxtState, indexingState }
 */
async function checkIndexStatus(url) {
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { status: 'ERROR', message: 'OAuth token refresh failed — re-run gsc-oauth-setup.js' };
  }
  if (!accessToken) {
    return { status: 'ERROR', message: 'GSC not configured — run gsc-oauth-setup.js first' };
  }

  try {
    const { statusCode, data } = await apiRequest(
      'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      accessToken,
      { inspectionUrl: url, siteUrl: GSC_SITE_URL }
    );

    if (statusCode !== 200) {
      return { status: 'ERROR', message: `GSC API returned ${statusCode}: ${JSON.stringify(data).slice(0, 200)}` };
    }

    const result = data.inspectionResult || {};
    const indexStatus = result.indexStatusResult || {};
    const verdict = indexStatus.verdict || 'UNKNOWN';

    // Map verdict to simple status
    let status;
    if (verdict === 'PASS') status = 'INDEXED';
    else if (verdict === 'PARTIAL') status = 'PARTIAL';
    else if (verdict === 'NEUTRAL' || verdict === 'VERDICT_UNSPECIFIED') status = 'NOT_INDEXED';
    else if (verdict === 'FAIL') status = 'NOT_INDEXED';
    else status = 'NOT_INDEXED';

    return {
      status,
      lastCrawled: indexStatus.lastCrawlTime || null,
      coverageState: indexStatus.coverageState || null,
      verdict,
      robotsTxtState: indexStatus.robotsTxtState || null,
      indexingState: indexStatus.indexingState || null,
    };
  } catch (err) {
    return { status: 'ERROR', message: `GSC inspection failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Submit for Indexing
// ---------------------------------------------------------------------------

/**
 * Submit a URL to Google for indexing via the Indexing API.
 * Falls back gracefully if the Indexing API is not enabled.
 *
 * @param {string} url - Full page URL
 * @returns {Promise<object>} { submitted: true/false, message }
 */
async function submitForIndexing(url) {
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { submitted: false, message: 'OAuth token refresh failed — re-run gsc-oauth-setup.js' };
  }
  if (!accessToken) {
    return { submitted: false, message: 'GSC not configured — run gsc-oauth-setup.js first' };
  }

  try {
    const { statusCode, data } = await apiRequest(
      'https://indexing.googleapis.com/v3/urlNotifications:publish',
      accessToken,
      { url, type: 'URL_UPDATED' }
    );

    if (statusCode === 200) {
      return { submitted: true, message: `Submitted — notifyTime: ${data.urlNotificationMetadata?.latestUpdate?.notifyTime || 'ok'}` };
    }

    // 403 typically means Indexing API not enabled or URL not verified
    if (statusCode === 403) {
      return { submitted: false, message: 'Indexing API not enabled or site not verified — enable via GCP console' };
    }

    return { submitted: false, message: `Indexing API returned ${statusCode}: ${JSON.stringify(data).slice(0, 200)}` };
  } catch (err) {
    return { submitted: false, message: `Indexing submission failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Post-Publish: Single
// ---------------------------------------------------------------------------

/**
 * Run the full post-publish pipeline on a single listing or post.
 *
 * @param {string|number} urlOrId - WP post URL or ID
 * @returns {Promise<object>} Results object
 */
async function postPublishSingle(urlOrId) {
  const warnings = [];
  console.log(`\n[post-publish] ========================================`);
  console.log(`[post-publish] Starting post-publish for: ${urlOrId}`);
  console.log(`[post-publish] ========================================\n`);

  // 1. Resolve the WP post
  console.log('[post-publish] Step 1: Resolving WP post...');
  let post;
  try {
    post = await resolvePost(urlOrId);
  } catch (err) {
    console.log(`[post-publish] FAILED: ${err.message}`);
    return { url: String(urlOrId), title: null, postId: null, linksAdded: { outbound: 0, inbound: 0 }, indexing: { status: 'SKIPPED' }, warnings: [err.message] };
  }

  const postUrl = post.link || `${SITE_URL}/?p=${post.id}`;
  const postTitle = (post.title?.rendered || post.title || '').replace(/<[^>]*>/g, '');
  console.log(`[post-publish] Resolved: "${postTitle}" (ID: ${post.id})`);
  console.log(`[post-publish] URL: ${postUrl}`);

  // 2. Refresh page index
  console.log('\n[post-publish] Step 2: Refreshing page index...');
  try {
    const indexResult = await refreshPageIndex();
    console.log(`[post-publish] Page index refreshed: ${indexResult.count} pages (${indexResult.posts} posts, ${indexResult.listings} listings)`);
  } catch (err) {
    const msg = `Page index refresh failed: ${err.message}`;
    console.log(`[post-publish] WARNING: ${msg}`);
    warnings.push(msg);
  }

  // 3. Retrofit linking — find posts that should link TO this post (inbound)
  console.log('\n[post-publish] Step 3: Running retrofit linking...');
  let linksAdded = { outbound: 0, inbound: 0 };
  try {
    const slug = post.slug || '';
    const corpus = await fetchCorpus();
    console.log(`[post-publish] Corpus loaded: ${corpus.length} published posts`);

    // Inbound: scan corpus for posts that should link TO this post
    const inboundProposals = scanCorpus(post, corpus);
    console.log(`[post-publish] Inbound link proposals found: ${inboundProposals.length}`);

    if (inboundProposals.length > 0) {
      // Auto-approve and apply proposals
      const result = await retrofitLinks(slug, { newPost: post, corpus });
      const appliedCount = (result.applied || []).filter(r => r.success).length;
      linksAdded.inbound = appliedCount;
      console.log(`[post-publish] Inbound links applied: ${appliedCount}`);
    }

    // Outbound: run retrofit from this post's perspective
    // (find opportunities in this post that should link to existing content)
    // This is handled by the page index + linker during initial publish
    // For post-publish, we log it as informational
    console.log(`[post-publish] Outbound linking handled by initial publish pipeline`);
  } catch (err) {
    const msg = `Retrofit linking failed: ${err.message}`;
    console.log(`[post-publish] WARNING: ${msg}`);
    warnings.push(msg);
  }

  // 4. Check Google indexing status
  console.log('\n[post-publish] Step 4: Checking Google indexing status...');
  let indexing = { status: 'SKIPPED', lastCrawled: null, verdict: null, submitted: false };
  const indexResult = await checkIndexStatus(postUrl);
  console.log(`[post-publish] Indexing status: ${indexResult.status}`);
  if (indexResult.lastCrawled) console.log(`[post-publish] Last crawled: ${indexResult.lastCrawled}`);
  if (indexResult.message) console.log(`[post-publish] Note: ${indexResult.message}`);

  indexing = {
    status: indexResult.status,
    lastCrawled: indexResult.lastCrawled || null,
    verdict: indexResult.verdict || null,
    submitted: false,
  };

  // 5. Submit for indexing if not indexed
  if (indexResult.status === 'NOT_INDEXED' || indexResult.status === 'PARTIAL') {
    console.log('\n[post-publish] Step 5: Submitting for indexing...');
    const submitResult = await submitForIndexing(postUrl);
    indexing.submitted = submitResult.submitted;
    console.log(`[post-publish] Submit result: ${submitResult.message}`);
    if (!submitResult.submitted) warnings.push(`Index submission: ${submitResult.message}`);
  } else if (indexResult.status === 'INDEXED') {
    console.log('\n[post-publish] Step 5: Already indexed — skipping submission');
  } else {
    console.log('\n[post-publish] Step 5: Indexing check unavailable — skipping submission');
    if (indexResult.message) warnings.push(indexResult.message);
  }

  console.log('\n[post-publish] ========================================');
  console.log(`[post-publish] DONE: "${postTitle}"`);
  console.log(`[post-publish]   Links: +${linksAdded.inbound} inbound, +${linksAdded.outbound} outbound`);
  console.log(`[post-publish]   Indexing: ${indexing.status}${indexing.submitted ? ' (submitted)' : ''}`);
  if (warnings.length) console.log(`[post-publish]   Warnings: ${warnings.length}`);
  console.log(`[post-publish] ========================================\n`);

  return {
    url: postUrl,
    title: postTitle,
    postId: post.id,
    linksAdded,
    indexing,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Post-Publish: Batch
// ---------------------------------------------------------------------------

/**
 * Run post-publish on multiple posts.
 *
 * @param {object} options
 * @param {string} [options.since] - Process posts published since YYYY-MM-DD
 * @param {number[]} [options.ids] - Specific post IDs
 * @param {string} [options.country] - Country code (e.g. 'AE') for recently published listings
 * @returns {Promise<object>} Summary
 */
async function postPublishBatch(options = {}) {
  console.log('\n[post-publish] ========================================');
  console.log('[post-publish] BATCH MODE');
  console.log(`[post-publish] Options: ${JSON.stringify(options)}`);
  console.log('[post-publish] ========================================\n');

  let postIds = [];

  if (options.ids && options.ids.length > 0) {
    // Explicit IDs
    postIds = options.ids;
    console.log(`[post-publish] Processing ${postIds.length} specific post IDs`);

  } else if (options.since) {
    // Posts published since a date
    console.log(`[post-publish] Fetching posts published since ${options.since}...`);
    const sinceDate = new Date(options.since).toISOString();

    // Fetch blog posts
    let page = 1;
    while (true) {
      try {
        const batch = await wpGet(`/wp-json/wp/v2/posts?per_page=100&page=${page}&status=publish&after=${sinceDate}&orderby=date&order=asc`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        postIds.push(...batch.map(p => p.id));
        if (batch.length < 100) break;
        page++;
      } catch (err) {
        if (page > 1 && err.message && err.message.includes('400')) break;
        throw err;
      }
    }

    // Fetch listings
    page = 1;
    while (true) {
      try {
        const batch = await wpGet(`/wp-json/wp/v2/listing?per_page=100&page=${page}&status=publish&after=${sinceDate}&orderby=date&order=asc`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        postIds.push(...batch.map(p => p.id));
        if (batch.length < 100) break;
        page++;
      } catch (err) {
        if (page > 1 && err.message && err.message.includes('400')) break;
        throw err;
      }
    }

    console.log(`[post-publish] Found ${postIds.length} posts/listings since ${options.since}`);

  } else if (options.country) {
    // Listings by country — search by region taxonomy or slug pattern
    const cc = options.country.toLowerCase();
    console.log(`[post-publish] Fetching listings for country: ${options.country}...`);

    let page = 1;
    while (true) {
      try {
        const batch = await wpGet(`/wp-json/wp/v2/listing?per_page=100&page=${page}&status=publish&search=${encodeURIComponent(cc)}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        // Filter by slug containing country code
        for (const listing of batch) {
          const slug = listing.slug || '';
          const link = listing.link || '';
          if (slug.includes(`-${cc}`) || slug.endsWith(`-${cc}`) || link.includes(`/${cc}/`)) {
            postIds.push(listing.id);
          }
        }
        if (batch.length < 100) break;
        page++;
      } catch (err) {
        if (page > 1 && err.message && err.message.includes('400')) break;
        throw err;
      }
    }

    console.log(`[post-publish] Found ${postIds.length} listings for country ${options.country}`);
  } else {
    console.log('[post-publish] No filter provided — use { since, ids, or country }');
    return { processed: 0, linksAdded: 0, indexed: 0, pendingIndex: 0, submitted: 0, errors: [], results: [] };
  }

  // Process each post
  const results = [];
  const errors = [];
  let totalLinksAdded = 0;
  let indexed = 0;
  let pendingIndex = 0;
  let submitted = 0;

  for (const id of postIds) {
    try {
      const result = await postPublishSingle(id);
      results.push(result);
      totalLinksAdded += (result.linksAdded.inbound + result.linksAdded.outbound);
      if (result.indexing.status === 'INDEXED') indexed++;
      else pendingIndex++;
      if (result.indexing.submitted) submitted++;
    } catch (err) {
      console.log(`[post-publish] ERROR processing ID ${id}: ${err.message}`);
      errors.push({ id, error: err.message });
    }
  }

  const summary = {
    processed: results.length,
    linksAdded: totalLinksAdded,
    indexed,
    pendingIndex,
    submitted,
    errors,
    results,
  };

  console.log('\n[post-publish] ========================================');
  console.log('[post-publish] BATCH COMPLETE');
  console.log(`[post-publish]   Processed: ${summary.processed}`);
  console.log(`[post-publish]   Links added: ${summary.linksAdded}`);
  console.log(`[post-publish]   Indexed: ${summary.indexed}`);
  console.log(`[post-publish]   Pending index: ${summary.pendingIndex}`);
  console.log(`[post-publish]   Submitted: ${summary.submitted}`);
  console.log(`[post-publish]   Errors: ${summary.errors.length}`);
  console.log('[post-publish] ========================================\n');

  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('Usage:');
    console.log('  node lib/post-publish.js single <url_or_id>');
    console.log('  node lib/post-publish.js batch --since 2026-05-15');
    console.log('  node lib/post-publish.js batch --country AE');
    console.log('  node lib/post-publish.js batch --ids 123,456,789');
    console.log('  node lib/post-publish.js check <url>');
    console.log('  node lib/post-publish.js submit <url>');
    process.exit(1);
  }

  if (command === 'single') {
    const target = args[1];
    if (!target) { console.log('Error: provide a URL or post ID'); process.exit(1); }
    const result = await postPublishSingle(target);
    console.log('\nResult:', JSON.stringify(result, null, 2));

  } else if (command === 'batch') {
    const flag = args[1];
    const value = args[2];
    if (!flag || !value) { console.log('Error: provide --since, --country, or --ids'); process.exit(1); }

    let options = {};
    if (flag === '--since') options.since = value;
    else if (flag === '--country') options.country = value;
    else if (flag === '--ids') options.ids = value.split(',').map(Number);
    else { console.log(`Unknown flag: ${flag}`); process.exit(1); }

    const result = await postPublishBatch(options);
    console.log('\nSummary:', JSON.stringify(result, null, 2));

  } else if (command === 'check') {
    const url = args[1];
    if (!url) { console.log('Error: provide a URL'); process.exit(1); }
    console.log(`[post-publish] Checking indexing status for: ${url}`);
    const result = await checkIndexStatus(url);
    console.log('\nResult:', JSON.stringify(result, null, 2));

  } else if (command === 'submit') {
    const url = args[1];
    if (!url) { console.log('Error: provide a URL'); process.exit(1); }
    console.log(`[post-publish] Submitting for indexing: ${url}`);
    const result = await submitForIndexing(url);
    console.log('\nResult:', JSON.stringify(result, null, 2));

  } else {
    console.log(`Unknown command: ${command}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[post-publish] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  postPublishSingle,
  postPublishBatch,
  checkIndexStatus,
  submitForIndexing,
  resolvePost,
  getAccessToken,
};
