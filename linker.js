/**
 * Internal Link Builder for Padeli Blog Pipeline
 *
 * Stage 5 of the production pipeline: funnel-aware internal linking
 * with anchor variation (30/50/20 rule).
 *
 * Reads a draft + page index, applies funnel-direction discipline,
 * and produces a linked draft with a Related Reading section.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const fs = require('fs');
const path = require('path');
const { SITE_URL } = require('./wp-client');
const { POST_TYPES } = require('./config');
const { slugify, countWords } = require('./utils');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_PATH = path.resolve(__dirname, '..', 'data', 'page_index.json');

/**
 * Map postType_tier combos to funnel positions.
 */
const FUNNEL_MAP = {
  'city_listicle_cornerstone': 'bofu',
  'product_listicle_cornerstone': 'bofu',
  'pillar_cornerstone': 'mofu',
  'cluster_cluster': 'mofu',
  'leaf_leaf': 'tofu',
};

/**
 * Link count targets per tier: [min, max]
 */
const LINK_TARGETS = {
  cornerstone: [8, 15],
  cluster: [5, 10],
  leaf: [3, 7],
};

/**
 * Generic anchor phrases pool.
 */
const GENERIC_ANCHORS = [
  'see our complete guide',
  'read more here',
  'explore the full list',
  'check out our guide',
  'see the full breakdown',
  'find out more',
  'get the details',
  'view the full guide',
  'learn more',
  'see the complete list',
];

// ---------------------------------------------------------------------------
// Page Index I/O
// ---------------------------------------------------------------------------

/**
 * Load page_index.json from disk.
 *
 * @param {string} [indexPath] - Path to page_index.json
 * @returns {object} Parsed page index { pages, listings, updated }
 */
function loadPageIndex(indexPath) {
  const p = indexPath || DEFAULT_INDEX_PATH;
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

/**
 * Save page index to disk.
 *
 * @param {object} index - Page index object
 * @param {string} [indexPath] - Path to write
 */
function savePageIndex(index, indexPath) {
  const p = indexPath || DEFAULT_INDEX_PATH;
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(index, null, 2) + '\n', 'utf8');
}

/**
 * Build a page index from an array of post objects.
 * Typically used to create the initial page_index.json from WP data.
 *
 * @param {Array<object>} posts - Array of post objects with at minimum:
 *   slug, title, post_type, tier, category, market, pillar_slug,
 *   wp_post_id, focus_keyword, status
 * @returns {object} Structured page index
 */
function buildPageIndex(posts) {
  const pages = posts.map((p) => ({
    slug: p.slug,
    title: p.title,
    post_type: p.post_type || 'leaf',
    tier: p.tier || 'leaf',
    funnel: classifyFunnelPosition(p.post_type || 'leaf', p.tier || 'leaf'),
    category: p.category || '',
    market: p.market || '',
    pillar_slug: p.pillar_slug || '',
    wp_post_id: p.wp_post_id || null,
    focus_keyword: p.focus_keyword || p.title,
    url: p.url || `/${p.slug}/`,
    status: p.status || 'draft',
    internal_links_in: p.internal_links_in || 0,
    internal_links_out: p.internal_links_out || 0,
  }));

  return {
    pages,
    listings: [],
    updated: new Date().toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Funnel Classification
// ---------------------------------------------------------------------------

/**
 * Classify a post's funnel position based on type and tier.
 *
 * @param {string} postType - e.g. 'city_listicle', 'pillar', 'cluster', 'leaf'
 * @param {string} tier - e.g. 'cornerstone', 'cluster', 'leaf'
 * @returns {'tofu'|'mofu'|'bofu'}
 */
function classifyFunnelPosition(postType, tier) {
  const key = `${postType}_${tier}`;
  if (FUNNEL_MAP[key]) return FUNNEL_MAP[key];

  // Fallback logic for unmapped combos
  if (postType === 'city_listicle' || postType === 'product_listicle') return 'bofu';
  if (postType === 'pillar') return 'mofu';
  if (postType === 'cluster') return 'mofu';
  return 'tofu';
}

// ---------------------------------------------------------------------------
// Link Target Selection
// ---------------------------------------------------------------------------

/**
 * Get valid link targets based on funnel position and direction rules.
 *
 * TOFU: UP to cornerstones/pillars, SIDEWAYS to other TOFU
 * MOFU: UP to pillars, ACROSS to siblings (same pillar), DOWN to leaves
 * BOFU: UP to pillars, DOWN to /listing/ pages
 *
 * @param {'tofu'|'mofu'|'bofu'} funnelPosition - Current post's funnel slot
 * @param {object} pageIndex - Full page index
 * @param {string} currentSlug - Current post slug (excluded from results)
 * @returns {Array<object>} Filtered target pages/listings
 */
function getValidLinkTargets(funnelPosition, pageIndex, currentSlug) {
  const pages = (pageIndex.pages || []).filter((p) => p.slug !== currentSlug && p.status === 'published');
  const listings = (pageIndex.listings || []).filter((l) => l.slug !== currentSlug);

  switch (funnelPosition) {
    case 'tofu': {
      // UP to cornerstones/pillars
      const upTargets = pages.filter(
        (p) => p.tier === 'cornerstone' || p.post_type === 'pillar'
      );
      // SIDEWAYS to other TOFU
      const sideTargets = pages.filter((p) => p.funnel === 'tofu');
      return [...upTargets, ...sideTargets];
    }

    case 'mofu': {
      // UP to pillars/cornerstones
      const upTargets = pages.filter(
        (p) => p.tier === 'cornerstone' || p.post_type === 'pillar'
      );
      // ACROSS to siblings (same pillar)
      const currentPage = (pageIndex.pages || []).find((p) => p.slug === currentSlug);
      const pillarSlug = currentPage ? currentPage.pillar_slug : '';
      const siblings = pillarSlug
        ? pages.filter((p) => p.pillar_slug === pillarSlug && p.funnel === 'mofu')
        : [];
      // DOWN to leaves
      const downTargets = pages.filter((p) => p.funnel === 'tofu');
      return [...upTargets, ...siblings, ...downTargets];
    }

    case 'bofu': {
      // UP to pillars/cornerstones
      const upTargets = pages.filter(
        (p) => p.tier === 'cornerstone' || p.post_type === 'pillar'
      );
      // DOWN to individual listings
      return [...upTargets, ...listings.map((l) => ({ ...l, funnel: 'listing' }))];
    }

    default:
      return pages;
  }
}

// ---------------------------------------------------------------------------
// Anchor Variation (30/50/20 Rule)
// ---------------------------------------------------------------------------

/**
 * Select anchor type based on position in the link sequence.
 * 30% exact, 50% partial, 20% generic.
 *
 * @param {number} linkIndex - 0-based index of this link in the sequence
 * @param {number} totalLinks - Total planned links
 * @returns {'exact'|'partial'|'generic'}
 */
function selectAnchorType(linkIndex, totalLinks) {
  if (totalLinks <= 0) return 'partial';
  const ratio = linkIndex / totalLinks;
  if (ratio < 0.3) return 'exact';
  if (ratio < 0.8) return 'partial';
  return 'generic';
}

/**
 * Generate anchor text for a target post.
 *
 * @param {object} targetPost - Target page/listing from the index
 * @param {'exact'|'partial'|'generic'} anchorType - Type of anchor
 * @param {string} [contextSentence] - Surrounding sentence (unused for now, for future NLP)
 * @returns {string} Anchor text string
 */
function generateAnchorText(targetPost, anchorType, contextSentence) {
  const title = targetPost.title || '';
  const keyword = targetPost.focus_keyword || title;

  switch (anchorType) {
    case 'exact':
      return keyword.toLowerCase();

    case 'partial': {
      // Generate a variation: drop year, simplify, or reframe
      let partial = keyword;

      // Drop trailing year (e.g. "2026", "2025")
      partial = partial.replace(/\s+\d{4}$/, '');

      // If still long, try simplifications
      if (partial.length > 40) {
        // Use just the city/topic portion
        const bestMatch = partial.match(/(?:padel courts? in |guide to |padel in )(.+)/i);
        if (bestMatch) {
          partial = `padel in ${bestMatch[1]}`;
        }
      }

      // Apply variation: prefix or suffix, avoiding redundancy
      partial = partial.toLowerCase();
      const prefixes = ['our guide to ', 'top ', ''];
      const suffixes = ['', ' venues', ' options'];
      const prefix = prefixes[_stableHash(keyword) % prefixes.length];
      const suffix = suffixes[_stableHash(keyword + 'suf') % suffixes.length];

      // Only add prefix if it doesn't duplicate words already in the text
      if (prefix) {
        const prefixWord = prefix.trim().split(/\s+/).pop(); // last word of prefix
        if (!partial.startsWith(prefixWord)) {
          partial = prefix + partial;
        }
      }
      // Only add suffix if not redundant
      if (suffix && !partial.endsWith(suffix.trim())) {
        partial = partial + suffix;
      }

      return partial;
    }

    case 'generic': {
      const idx = _stableHash(targetPost.slug || title) % GENERIC_ANCHORS.length;
      return GENERIC_ANCHORS[idx];
    }

    default:
      return keyword.toLowerCase();
  }
}

/**
 * Simple deterministic hash for stable but varied selections.
 * @param {string} str
 * @returns {number}
 */
function _stableHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ---------------------------------------------------------------------------
// Link Insertion
// ---------------------------------------------------------------------------

/**
 * Insert an <a> tag into HTML at a given position.
 *
 * @param {string} html - Current HTML string
 * @param {string} anchorText - Text to wrap in the link
 * @param {string} targetUrl - href value
 * @param {number} position - Character index in HTML to insert at
 * @returns {string} Modified HTML
 */
function insertLink(html, anchorText, targetUrl, position) {
  const fullUrl = targetUrl.startsWith('http') ? targetUrl : SITE_URL + targetUrl;
  const tag = `<a href="${fullUrl}">${anchorText}</a>`;

  // If position is valid and falls inside the HTML, splice it in
  if (position >= 0 && position <= html.length) {
    return html.slice(0, position) + tag + html.slice(position);
  }

  // Fallback: append before closing </p> of first paragraph
  return html.replace(/<\/p>/, ` ${tag}</p>`);
}

// ---------------------------------------------------------------------------
// Related Reading Section
// ---------------------------------------------------------------------------

/**
 * Add a "Related Reading" section at the end of the HTML body.
 *
 * @param {string} html - Current HTML
 * @param {Array<object>} targets - Candidate link targets
 * @param {number} [count=3] - Number of related links to include
 * @returns {string} HTML with Related Reading appended
 */
function addRelatedReading(html, targets, count = 3) {
  if (!targets || targets.length === 0) return html;

  const selected = targets.slice(0, count);
  const items = selected.map((t) => {
    const url = t.url
      ? (t.url.startsWith('http') ? t.url : SITE_URL + t.url)
      : SITE_URL + '/' + t.slug + '/';
    return `<li><a href="${url}">${t.title}</a></li>`;
  });

  const section = [
    '',
    '<!-- wp:heading {"level":2} -->',
    '<h2 class="wp-block-heading">Related Reading</h2>',
    '<!-- /wp:heading -->',
    '',
    '<!-- wp:list -->',
    '<ul class="wp-block-list">',
    ...items,
    '</ul>',
    '<!-- /wp:list -->',
  ].join('\n');

  return html + '\n' + section + '\n';
}

// ---------------------------------------------------------------------------
// Link Density Check
// ---------------------------------------------------------------------------

/**
 * Analyse link density in HTML content.
 *
 * @param {string} html - HTML string
 * @returns {{ internal: number, external: number, density: number, isOverLinked: boolean }}
 */
function checkLinkDensity(html) {
  const allLinks = html.match(/<a\s[^>]*href="[^"]*"[^>]*>/gi) || [];
  let internal = 0;
  let external = 0;

  for (const link of allLinks) {
    const hrefMatch = link.match(/href="([^"]*)"/);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    if (href.startsWith(SITE_URL) || href.startsWith('/')) {
      internal++;
    } else if (href.startsWith('http')) {
      external++;
    }
  }

  const words = countWords(html);
  const density = words > 0 ? (internal + external) / (words / 100) : 0;

  return {
    internal,
    external,
    density: Math.round(density * 100) / 100,
    isOverLinked: density > 3, // more than 3 links per 100 words = too many
  };
}

// ---------------------------------------------------------------------------
// Planned Link Resolution
// ---------------------------------------------------------------------------

/**
 * Find [PLANNED:URL] markers left by the content pipeline.
 *
 * @param {string} html - HTML string
 * @returns {Array<{ marker: string, url: string, position: number }>}
 */
function findPlannedLinks(html) {
  const regex = /\[PLANNED:(\/[^\]]+)\]/g;
  const results = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    results.push({
      marker: match[0],
      url: match[1],
      position: match.index,
    });
  }
  return results;
}

/**
 * Resolve [PLANNED:URL] markers by matching against the page index
 * and inserting proper links.
 *
 * @param {string} html - HTML with [PLANNED:...] markers
 * @param {object} pageIndex - Page index
 * @returns {string} HTML with resolved links
 */
function resolvePlannedLinks(html, pageIndex) {
  const allPages = [...(pageIndex.pages || []), ...(pageIndex.listings || [])];
  let result = html;

  const planned = findPlannedLinks(result);
  for (const item of planned) {
    // Find matching page by URL
    const target = allPages.find(
      (p) => p.url === item.url || `/${p.slug}/` === item.url
    );

    if (target) {
      const fullUrl = item.url.startsWith('http') ? item.url : SITE_URL + item.url;
      const anchor = target.title || target.slug;
      const link = `<a href="${fullUrl}">${anchor}</a>`;
      result = result.replace(item.marker, link);
    }
    // If no match found, leave the marker (validateLinks will flag it)
  }

  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate internal links in HTML.
 *
 * Checks:
 * - No self-links
 * - No remaining [PLANNED:URL] markers
 * - No links in FAQ questions (only in answers)
 * - Link count within tier range
 * - No broken hrefs (format check, not live)
 *
 * @param {string} html - HTML string
 * @param {string} slug - Current post slug
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateLinks(html, slug) {
  const errors = [];
  const warnings = [];

  // 1. Check for self-links
  const selfLinkPatterns = [
    new RegExp(`href="${SITE_URL}/${slug}/?"`, 'gi'),
    new RegExp(`href="/${slug}/?"`, 'gi'),
  ];
  for (const pattern of selfLinkPatterns) {
    if (pattern.test(html)) {
      errors.push(`Self-link detected: post links to its own URL (/${slug}/)`);
    }
  }

  // 2. Check for unresolved [PLANNED:URL] markers
  const planned = findPlannedLinks(html);
  if (planned.length > 0) {
    for (const p of planned) {
      errors.push(`Unresolved planned link marker: ${p.marker}`);
    }
  }

  // 3. Check for links in FAQ questions (not answers)
  // FAQ pattern: <h3>...</h3> or <strong>Q:...</strong> immediately before answer
  const faqQuestionLinks = html.match(
    /<h[23][^>]*>(?:<[^>]*>)*[^<]*<a\s[^>]*>[^<]*<\/a>[^<]*(?:<[^>]*>)*<\/h[23]>/gi
  );
  if (faqQuestionLinks && faqQuestionLinks.length > 0) {
    errors.push(
      `Found ${faqQuestionLinks.length} link(s) inside FAQ question headings — links belong in answer body only`
    );
  }

  // 4. Check href format (no empty, no javascript:, no malformed)
  const hrefRegex = /href="([^"]*)"/gi;
  let hrefMatch;
  while ((hrefMatch = hrefRegex.exec(html)) !== null) {
    const href = hrefMatch[1];
    if (!href || href === '#') {
      warnings.push(`Empty or hash-only href found: "${href}"`);
    }
    if (href.startsWith('javascript:')) {
      errors.push(`JavaScript href found: "${href}"`);
    }
    if (href.startsWith(SITE_URL) || href.startsWith('/')) {
      // Internal link — check it looks like a valid path
      const urlPath = href.replace(SITE_URL, '');
      if (!/^\/[a-z0-9\-\/]*\/?$/.test(urlPath)) {
        warnings.push(`Internal link with unusual path format: "${href}"`);
      }
    }
  }

  // 5. Count internal links and check against tier ranges
  const density = checkLinkDensity(html);
  // We can only warn here since we don't know the tier — applyInternalLinks handles the full check
  if (density.internal === 0) {
    warnings.push('No internal links found in the content');
  }
  if (density.isOverLinked) {
    warnings.push(
      `Link density is high: ${density.density} links per 100 words (${density.internal} internal, ${density.external} external)`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// WP REST API Integration
// ---------------------------------------------------------------------------

/**
 * Fetch all published posts and listings from the WP REST API
 * and build a flat page index array.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent=false] - Suppress console warnings
 * @returns {Promise<Array<object>>} Array of page objects
 */
async function buildPageIndexFromWP(options = {}) {
  let wpGet;
  try {
    wpGet = require('./wp-client').wpGet;
  } catch (err) {
    if (!options.silent) console.warn('[linker] wp-client not available:', err.message);
    return [];
  }

  const pages = [];

  // --- Fetch all published blog posts (paginated) ---
  try {
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const posts = await wpGet(
        `/wp-json/wp/v2/posts?status=publish&per_page=100&page=${page}&_fields=id,slug,title,link,categories,yoast_head_json`
      );
      if (!posts || posts.length === 0) { hasMore = false; break; }
      for (const post of posts) {
        pages.push({
          id: post.id,
          slug: post.slug,
          title: post.title?.rendered || '',
          url: post.link || `${SITE_URL}/${post.slug}/`,
          type: 'post',
          categories: post.categories || [],
          focus_keyword: post.yoast_head_json?.title || '',
        });
      }
      page++;
      if (posts.length < 100) hasMore = false;
    }
  } catch (err) {
    if (!options.silent) console.warn('[linker] Failed to fetch posts from WP:', err.message);
  }

  // --- Fetch all published listings (paginated) ---
  try {
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const listings = await wpGet(
        `/wp-json/wp/v2/listing?status=publish&per_page=100&page=${page}&_fields=id,slug,title,link`
      );
      if (!listings || listings.length === 0) { hasMore = false; break; }
      for (const listing of listings) {
        pages.push({
          id: listing.id,
          slug: listing.slug,
          title: listing.title?.rendered || '',
          url: listing.link || `${SITE_URL}/listing/${listing.slug}/`,
          type: 'listing',
        });
      }
      page++;
      if (listings.length < 100) hasMore = false;
    }
  } catch (err) {
    if (!options.silent) console.warn('[linker] Failed to fetch listings from WP:', err.message);
  }

  return pages;
}

/**
 * Resolve [PLANNED:slug] markers in HTML against a page index.
 *
 * Markers look like [PLANNED:/some-slug/] — this function matches the slug
 * portion against pages in the index and replaces the marker with the real URL.
 * The surrounding text (which wraps the marker) becomes the visible anchor
 * when the caller builds <a> tags.
 *
 * @param {string} html - HTML containing [PLANNED:/slug/] markers
 * @param {Array<object>} pageIndex - Flat array of page objects (from buildPageIndexFromWP or similar)
 * @returns {{ html: string, resolved: Array<object>, unresolved: string[] }}
 */
function resolvePlannedMarkers(html, pageIndex) {
  const resolved = [];
  const unresolved = [];

  const result = html.replace(/\[PLANNED:(\/[^\]]+\/)\]/g, (match, slug) => {
    const cleanSlug = slug.replace(/^\/|\/$/g, '');
    const page = pageIndex.find((p) => p.slug === cleanSlug);
    if (page) {
      resolved.push({ slug: cleanSlug, url: page.url, title: page.title });
      return page.url;
    }
    unresolved.push(cleanSlug);
    return match; // Leave marker if no match found
  });

  return { html: result, resolved, unresolved };
}

/**
 * Convenience: fetch all content from WP REST API and save to the local
 * page_index.json cache.
 *
 * @returns {Promise<{ count: number, posts: number, listings: number }>}
 */
async function refreshPageIndex() {
  const pages = await buildPageIndexFromWP();
  const index = {
    pages: pages.filter((p) => p.type === 'post'),
    listings: pages.filter((p) => p.type === 'listing'),
    updated: new Date().toISOString().slice(0, 10),
  };
  savePageIndex(index);
  return {
    count: pages.length,
    posts: index.pages.length,
    listings: index.listings.length,
  };
}

// ---------------------------------------------------------------------------
// Core: applyInternalLinks
// ---------------------------------------------------------------------------

/**
 * Apply funnel-aware internal links to an HTML draft.
 *
 * 1. Classify this post's funnel position
 * 2. Get valid link targets based on funnel direction
 * 3. Scan the body for natural anchor points
 * 4. Select anchor type per the 30/50/20 distribution
 * 5. Insert links with guardrails (no FAQ questions, no self-links,
 *    max 1 link per paragraph, no duplicate targets)
 * 6. Add Related Reading section
 * 7. Return { html, linksApplied, report }
 *
 * @param {string} html - Draft HTML
 * @param {object} pageIndex - Page index from page_index.json
 * @param {object} postMeta - Current post metadata:
 *   { slug, post_type, tier, pillar_slug, focus_keyword }
 * @param {object} [options] - Optional overrides
 * @param {number} [options.maxLinks] - Override max link count
 * @param {number} [options.relatedCount=3] - Number of Related Reading links
 * @param {boolean} [options.skipRelatedReading=false] - Skip Related Reading section
 * @returns {{ html: string, linksApplied: number, report: string[] }}
 */
function applyInternalLinks(html, pageIndex, postMeta, options = {}) {
  const report = [];
  let result = html;

  // Step 0a: Check if page index is empty or stale (>24h)
  const allPages = [...(pageIndex.pages || []), ...(pageIndex.listings || [])];
  if (allPages.length === 0) {
    report.push('WARNING: Page index is empty — run refreshPageIndex() to populate from WP REST API');
  } else if (pageIndex.updated) {
    const updatedDate = new Date(pageIndex.updated);
    const ageMs = Date.now() - updatedDate.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > 24) {
      report.push(
        `WARNING: Page index is ${Math.round(ageHours)}h old — consider running refreshPageIndex() to update from WP REST API`
      );
    }
  }

  // Step 0b: Resolve any [PLANNED:URL] markers first
  const plannedBefore = findPlannedLinks(result);
  if (plannedBefore.length > 0) {
    result = resolvePlannedLinks(result, pageIndex);
    const plannedAfter = findPlannedLinks(result);
    const resolved = plannedBefore.length - plannedAfter.length;
    report.push(`Resolved ${resolved}/${plannedBefore.length} planned link markers`);
  }

  // Step 1: Classify funnel position
  const postType = postMeta.post_type || 'leaf';
  const tier = postMeta.tier || 'leaf';
  const funnel = classifyFunnelPosition(postType, tier);
  report.push(`Funnel position: ${funnel} (${postType}/${tier})`);

  // Step 2: Get valid link targets
  const targets = getValidLinkTargets(funnel, pageIndex, postMeta.slug);
  report.push(`Valid link targets: ${targets.length}`);

  if (targets.length === 0) {
    report.push('No valid link targets found — skipping linking');
    return { html: result, linksApplied: 0, report };
  }

  // Step 3: Determine link budget
  const tierRange = LINK_TARGETS[tier] || LINK_TARGETS.leaf;
  const maxLinks = options.maxLinks || tierRange[1];
  const minLinks = tierRange[0];

  // Step 4: Extract paragraphs and find natural anchor points
  // We work on <p> tags only, skipping FAQ question headings
  const paragraphs = _extractLinkableParagraphs(result);
  report.push(`Linkable paragraphs found: ${paragraphs.length}`);

  // Step 5: Match targets to paragraphs and insert links
  const linkedTargets = new Set();
  const linkedParagraphIndices = new Set();
  let linksApplied = 0;

  // Sort targets by relevance: prioritise those with higher link-in demand (fewer existing inbound links)
  const sortedTargets = [...targets].sort((a, b) => {
    const aIn = a.internal_links_in || 0;
    const bIn = b.internal_links_in || 0;
    return aIn - bIn; // Fewer inbound links = higher priority
  });

  // De-duplicate targets by slug
  const uniqueTargets = [];
  const seenSlugs = new Set();
  for (const t of sortedTargets) {
    const s = t.slug;
    if (!seenSlugs.has(s)) {
      seenSlugs.add(s);
      uniqueTargets.push(t);
    }
  }

  for (const target of uniqueTargets) {
    if (linksApplied >= maxLinks) break;

    // Try to find a paragraph that mentions something related to this target
    const matchResult = _findBestParagraphMatch(
      paragraphs,
      target,
      linkedParagraphIndices,
      result
    );

    if (!matchResult) continue;

    const { paragraphIdx, matchText, matchPosition } = matchResult;

    // Determine anchor type
    const anchorType = selectAnchorType(linksApplied, maxLinks);
    const anchorText = generateAnchorText(target, anchorType);
    const targetUrl = target.url || `/${target.slug}/`;
    const fullUrl = targetUrl.startsWith('http') ? targetUrl : SITE_URL + targetUrl;

    // Build the link tag
    const linkTag = `<a href="${fullUrl}">${anchorText}</a>`;

    // Replace the matched text in the paragraph with the link
    // We replace only the first occurrence within this specific paragraph
    const oldParagraph = matchResult.paragraphHtml;
    const newParagraph = oldParagraph.replace(matchText, linkTag);

    if (oldParagraph !== newParagraph) {
      result = result.replace(oldParagraph, newParagraph);
      linkedTargets.add(target.slug);
      linkedParagraphIndices.add(paragraphIdx);
      linksApplied++;

      report.push(
        `[${anchorType}] Linked "${anchorText}" → ${targetUrl} (para ${paragraphIdx})`
      );
    }
  }

  // Step 6: Add Related Reading section
  if (!options.skipRelatedReading) {
    const relatedCount = options.relatedCount || 3;
    // Pick targets not already linked in body
    const relatedCandidates = uniqueTargets.filter(
      (t) => !linkedTargets.has(t.slug) && t.title
    );
    result = addRelatedReading(result, relatedCandidates, relatedCount);
    const addedRelated = Math.min(relatedCandidates.length, relatedCount);
    if (addedRelated > 0) {
      report.push(`Added Related Reading section with ${addedRelated} links`);
      linksApplied += addedRelated;
    }
  }

  // Step 7: Final checks
  if (linksApplied < minLinks) {
    report.push(
      `WARNING: Only ${linksApplied} links applied, below minimum of ${minLinks} for tier "${tier}"`
    );
  }

  const densityCheck = checkLinkDensity(result);
  if (densityCheck.isOverLinked) {
    report.push(
      `WARNING: Over-linked — ${densityCheck.density} links per 100 words`
    );
  }

  report.push(`Total links applied: ${linksApplied}`);

  return { html: result, linksApplied, report };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Extract paragraphs that are valid for linking.
 * Excludes FAQ question headings and paragraphs already containing links.
 *
 * @param {string} html
 * @returns {Array<{ idx: number, html: string, text: string, isInFaqAnswer: boolean }>}
 */
function _extractLinkableParagraphs(html) {
  const results = [];
  // Match <p> tags with their content
  const pRegex = /<p[^>]*>[\s\S]*?<\/p>/gi;
  let match;
  let idx = 0;

  // Detect FAQ zones: content between FAQ-related <h2>/<h3> and the next heading
  // We'll mark paragraphs that are inside FAQ answer sections (linkable)
  // vs FAQ question text (not linkable — but questions are in headings, not <p>)

  while ((match = pRegex.exec(html)) !== null) {
    const pHtml = match[0];
    const pText = pHtml.replace(/<[^>]*>/g, '').trim();

    // Skip empty paragraphs
    if (!pText) continue;

    // Skip paragraphs that already have a link
    if (/<a\s/i.test(pHtml)) {
      idx++;
      continue;
    }

    results.push({
      idx,
      html: pHtml,
      text: pText,
      position: match.index,
    });
    idx++;
  }

  return results;
}

/**
 * Find the best paragraph to insert a link for a given target.
 * Looks for keyword/title mentions in the paragraph text.
 *
 * @param {Array<object>} paragraphs - Linkable paragraphs
 * @param {object} target - Target page/listing
 * @param {Set<number>} usedParagraphs - Already-used paragraph indices
 * @param {string} fullHtml - The full HTML (for context)
 * @returns {object|null} { paragraphIdx, matchText, matchPosition, paragraphHtml }
 */
function _findBestParagraphMatch(paragraphs, target, usedParagraphs, fullHtml) {
  // Build search terms from the target
  const searchTerms = _buildSearchTerms(target);

  for (const para of paragraphs) {
    // Skip already-used paragraphs (max 1 link per paragraph)
    if (usedParagraphs.has(para.idx)) continue;

    // Check if this paragraph is inside an FAQ question heading (safety check)
    // The paragraph extractor already skips <h> tags, but double-check
    // by looking at surrounding context
    if (_isInsideFaqQuestion(para.position, fullHtml)) continue;

    // Try to match any search term in the paragraph text
    for (const term of searchTerms) {
      const termLower = term.toLowerCase();
      const textLower = para.text.toLowerCase();
      const pos = textLower.indexOf(termLower);

      if (pos !== -1) {
        // Extract the actual matched text (preserving original case)
        const matchText = para.text.slice(pos, pos + term.length);
        return {
          paragraphIdx: para.idx,
          matchText,
          matchPosition: pos,
          paragraphHtml: para.html,
        };
      }
    }
  }

  // No direct match found — try inserting at a suitable paragraph anyway
  // Pick the first available paragraph that hasn't been used
  for (const para of paragraphs) {
    if (usedParagraphs.has(para.idx)) continue;
    if (_isInsideFaqQuestion(para.position, fullHtml)) continue;
    if (para.text.split(/\s+/).length < 15) continue; // Skip very short paragraphs

    // We'll append the link at the end of the paragraph
    // Find a good insertion point (before the closing </p>)
    const closingP = para.html.lastIndexOf('</p>');
    if (closingP === -1) continue;

    return {
      paragraphIdx: para.idx,
      matchText: '</p>',
      matchPosition: closingP,
      paragraphHtml: para.html,
    };
  }

  return null;
}

/**
 * Build search terms from a target post for matching in paragraph text.
 * Returns terms in priority order (most specific first).
 *
 * @param {object} target
 * @returns {string[]}
 */
function _buildSearchTerms(target) {
  const terms = [];
  const kw = target.focus_keyword || '';
  const title = target.title || '';
  const city = target.city || '';

  // Exact keyword
  if (kw) terms.push(kw);

  // Keyword without year
  if (kw) {
    const noYear = kw.replace(/\s+\d{4}$/, '').trim();
    if (noYear !== kw) terms.push(noYear);
  }

  // Title if different from keyword
  if (title && title.toLowerCase() !== kw.toLowerCase()) {
    terms.push(title);
  }

  // City name for listing targets
  if (city) terms.push(city);

  // Key topic words (3+ chars, excluding stop words)
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'our', 'your', 'best', 'top',
    'how', 'what', 'guide', 'complete', 'from', 'that', 'this',
    'are', 'was', 'has', 'have', 'will', 'can',
  ]);
  const topicWords = (kw || title)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stopWords.has(w));
  if (topicWords.length >= 2) {
    // Two-word combinations
    for (let i = 0; i < topicWords.length - 1; i++) {
      terms.push(`${topicWords[i]} ${topicWords[i + 1]}`);
    }
  }

  // De-duplicate preserving order
  const seen = new Set();
  return terms.filter((t) => {
    const lower = t.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

/**
 * Check if a position in the HTML falls inside an FAQ question heading.
 * FAQ questions are typically in <h2> or <h3> tags.
 *
 * @param {number} position - Character index in HTML
 * @param {string} html - Full HTML
 * @returns {boolean}
 */
function _isInsideFaqQuestion(position, html) {
  // Look backwards from position for the nearest opening heading tag
  const before = html.slice(Math.max(0, position - 200), position);
  const hasOpenH = /<h[23][^>]*>[^<]*$/i.test(before);
  if (!hasOpenH) return false;

  // Check if we're before the closing heading tag
  const after = html.slice(position, position + 200);
  const hasCloseH = /^[^<]*<\/h[23]>/i.test(after);
  return hasCloseH;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  applyInternalLinks,
  buildPageIndex,
  buildPageIndexFromWP,
  loadPageIndex,
  savePageIndex,
  refreshPageIndex,
  classifyFunnelPosition,
  getValidLinkTargets,
  selectAnchorType,
  generateAnchorText,
  insertLink,
  addRelatedReading,
  checkLinkDensity,
  findPlannedLinks,
  resolvePlannedLinks,
  resolvePlannedMarkers,
  validateLinks,
  FUNNEL_MAP,
};
