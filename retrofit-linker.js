/**
 * Retrofit Linker for Padeli Blog Pipeline
 *
 * Runs within 24 hours of publishing a new post. Scans the entire existing
 * corpus to find older posts that should now link TO the newly published post.
 * Generates proposals and optionally applies them via WP REST.
 *
 * A new post with no inbound links from older posts is an orphan. Topical
 * authority compounds when posts link to each other. Retrofit is how the
 * corpus benefits from every new piece.
 *
 * Node.js v24+ — CommonJS — zero external dependencies
 */

const fs = require('fs');
const path = require('path');
const { SITE_URL, wpGet, wpPut } = require('./wp-client');
const { POST_TYPES } = require('./config');
const { countWords, stripHtml, slugify, normalise } = require('./utils');

// ---------------------------------------------------------------------------
// Geo inference (city / country / region)
//
// Padeli URLs are geo-nested: /clubs/{cc}/{city}/{slug}/, /coaching/{cc}/{city}/...,
// /tournaments/{cc}/{city}/...  and the region hubs themselves are /clubs/{cc}/{city}/.
// A blog about "best padel in Dubai" should prefer Dubai listings + the Dubai hub —
// so we extract {cc, city} from whatever signal a page carries (URL first, then meta,
// then slug/title). Accuracy-first: we only assert geo we can actually read; never invent.
// ---------------------------------------------------------------------------

/**
 * Pull a {cc, city} pair out of a geo-nested padeli URL.
 * Matches /{section}/{cc}/{city}/...  where section ∈ clubs|coaching|tournaments
 * and cc is a 2-letter country code. Returns {} if the URL is not geo-nested.
 *
 * @param {string} url - Full or relative padeli URL
 * @returns {{cc?: string, city?: string}}
 */
function geoFromUrl(url) {
  if (!url) return {};
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const m = path.match(/^\/(?:clubs|coaching|tournaments)\/([a-z]{2})\/([a-z0-9-]+)\//i);
  if (!m) return {};
  return { cc: m[1].toLowerCase(), city: m[2].toLowerCase() };
}

/**
 * Best-effort geo for any page: URL first (most reliable), then meta, then slug.
 * city is returned as a normalised slug ("abu-dhabi") AND a spaced form for text matching.
 *
 * @param {object} page - WP post/listing OR a page_index entry
 * @returns {{cc: string, city: string, cityText: string}}
 */
function inferGeo(page) {
  if (!page) return { cc: '', city: '', cityText: '' };
  const meta = page.meta || {};

  // 1. URL (page.link from WP REST, or page.url from page_index)
  const fromUrl = geoFromUrl(page.link || page.url || '');
  let cc = fromUrl.cc || '';
  let city = fromUrl.city || '';

  // 2. Meta fallbacks (only if URL gave nothing)
  if (!cc) cc = String(meta.country_code || meta._country_code || '').toLowerCase();
  if (!city) {
    const mCity = meta.city || meta._city || meta._geolocation_city || '';
    if (mCity) city = slugify(String(mCity));
  }

  // 3. Slug fallback for BLOG posts (their URL is flat, e.g.
  //    /best-padel-courts-brighton-2026/). Published blogs carry no city meta, so the
  //    slug is the only geo signal. We extract a city slug here; it only becomes a real
  //    match downstream if a region hub / listing actually shares that city slug — so
  //    no invented geo leaks through (accuracy-first).
  if (!city) {
    const slugCity = cityFromSlug(page.slug || '');
    if (slugCity) city = slugCity;
  }

  const cityText = city ? city.replace(/-/g, ' ') : '';
  return { cc, city, cityText };
}

/**
 * Extract a city slug from a blog slug using the known city URL patterns.
 * Mirrors the patterns in extractKeyTerms.
 *
 * @param {string} slug
 * @returns {string} city slug (e.g. "brighton", "canary-wharf") or ''
 */
function cityFromSlug(slug) {
  if (!slug) return '';
  const patterns = [
    /best-padel-(?:courts|clubs|centres|centers)-(.+?)(?:-\d{4})?$/,
    /padel-(?:courts|clubs|centres|centers)-(?:in-)?(.+?)(?:-\d{4})?$/,
    /where-to-play-padel-(?:in-)?(.+?)(?:-\d{4})?$/,
    /^padel-in-(.+?)(?:-\d{4})?$/,
  ];
  for (const p of patterns) {
    const m = slug.match(p);
    if (m && m[1]) {
      const c = m[1].replace(/^-+|-+$/g, '');
      // Guard against country-level / generic suffixes that aren't cities.
      if (c && !['uk', 'usa', 'us', 'gb', 'ae', 'uae'].includes(c)) return c;
    }
  }
  return '';
}

/**
 * True if the two pages resolve to the same city (preferred) or, failing a
 * city match, the same country. Used as the geo signal in classifyRelationship.
 *
 * @returns {'city'|'country'|'none'}
 */
function geoMatchLevel(a, b) {
  const ga = inferGeo(a);
  const gb = inferGeo(b);
  if (ga.city && gb.city && ga.city === gb.city) return 'city';
  if (ga.cc && gb.cc && ga.cc === gb.cc) return 'country';
  return 'none';
}

// ---------------------------------------------------------------------------
// Key term extraction
// ---------------------------------------------------------------------------

/**
 * Extract key terms from a post that other posts might mention.
 * Pulls from slug, title, and meta fields.
 *
 * @param {object} post - WP post object with slug, title, meta
 * @returns {string[]} Array of lowercase key terms, longest first
 */
function extractKeyTerms(post) {
  const terms = new Set();
  const title = (post.title?.rendered || post.title || '').replace(/<[^>]*>/g, '');

  // Full title (minus year suffix like "2026")
  const titleNoYear = title.replace(/\s+\d{4}$/, '').trim();
  if (titleNoYear.length > 3) terms.add(titleNoYear.toLowerCase());

  // Slug segments — e.g. "best-padel-courts-birmingham-2026"
  const slugParts = (post.slug || '').split('-').filter(Boolean);

  // City name extraction: look for known patterns
  // "best-padel-courts-{city}-2026" or "{city}-padel-clubs"
  const cityPatterns = [
    /best-padel-(?:courts|clubs|centres|centers)-(.+?)(?:-\d{4})?$/,
    /padel-(?:courts|clubs|centres|centers)-(?:in-)?(.+?)(?:-\d{4})?$/,
    /^(.+?)-padel-(?:courts|clubs|centres|centers|guide|scene)/,
    /where-to-play-padel-(?:in-)?(.+?)(?:-\d{4})?$/,
  ];

  for (const pattern of cityPatterns) {
    const match = (post.slug || '').match(pattern);
    if (match) {
      const city = match[1].replace(/-/g, ' ').trim();
      if (city.length > 2) terms.add(city.toLowerCase());
    }
  }

  // Extract meaningful multi-word phrases from title
  const titleLower = title.toLowerCase();
  // Remove common filler: "best", "top", "guide", year, "in", "the"
  const meaningful = titleLower
    .replace(/\b(best|top|guide|ultimate|complete|\d{4}|in|the|a|an|to|for|of|and|or)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (meaningful.length > 3) terms.add(meaningful);

  // Individual significant words from slug (3+ chars, not stopwords)
  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'from', 'your', 'that', 'this',
    'best', 'top', 'how', 'what', 'why', 'when', 'where', 'who',
    'guide', 'ultimate', 'complete', '2024', '2025', '2026', '2027',
  ]);
  for (const part of slugParts) {
    if (part.length >= 4 && !stopwords.has(part)) {
      terms.add(part.toLowerCase());
    }
  }

  // Post meta: pillar_keyword, focus_keyword, city
  const meta = post.meta || {};
  for (const key of ['pillar_keyword', 'focus_keyword', 'city', 'target_keyword']) {
    const val = meta[key];
    if (val && typeof val === 'string' && val.length > 2) {
      terms.add(val.toLowerCase().trim());
    }
  }

  // Sort longest first — longer terms are more specific matches
  return Array.from(terms).sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Relationship classification
// ---------------------------------------------------------------------------

/**
 * Classify the relationship between the new post and an existing post.
 *
 * @param {object} newPost - The newly published post
 * @param {object} existingPost - An existing corpus post
 * @returns {'pillar-child'|'sibling'|'parent-child'|'topical'|'none'}
 */
function classifyRelationship(newPost, existingPost) {
  const newMeta = newPost.meta || {};
  const existMeta = existingPost.meta || {};

  const newType = newMeta.post_type || inferPostType(newPost);
  const existType = existMeta.post_type || inferPostType(existingPost);

  const newPillar = normalise(newMeta.pillar_slug || newMeta.pillar || '');
  const existPillar = normalise(existMeta.pillar_slug || existMeta.pillar || '');

  // Both belong to the same pillar group
  if (newPillar && existPillar && newPillar === existPillar) {
    // Existing is the pillar itself → pillar-child
    if (existType === POST_TYPES.PILLAR) return 'pillar-child';
    // New is the pillar → parent-child (existing is under it)
    if (newType === POST_TYPES.PILLAR) return 'parent-child';
    // Both are under same pillar → sibling
    return 'sibling';
  }

  // Same category or overlapping tags → topical
  const newCats = new Set((newPost.categories || []).map(String));
  const existCats = new Set((existingPost.categories || []).map(String));
  for (const c of newCats) {
    if (existCats.has(c)) return 'topical';
  }

  const newTags = new Set((newPost.tags || []).map(String));
  const existTags = new Set((existingPost.tags || []).map(String));
  for (const t of newTags) {
    if (existTags.has(t)) return 'topical';
  }

  // Slug-based heuristic: shared significant words
  const newSlugWords = new Set(
    (newPost.slug || '').split('-').filter((w) => w.length >= 4)
  );
  const existSlugWords = (existingPost.slug || '').split('-').filter((w) => w.length >= 4);
  let overlap = 0;
  for (const w of existSlugWords) {
    if (newSlugWords.has(w)) overlap++;
  }
  if (overlap >= 2) return 'topical';

  // Geo signal (added 2026-06-12 per LINKING-ARCHITECTURE-DECISION):
  // a same-city pair (e.g. a "best padel in Dubai" blog and a Dubai listing/blog)
  // is topically related even with no shared pillar/category/tag/slug words.
  // Same-country is a weaker signal — only treat as topical when at least one side
  // is a blog post (city/country guides are the pages that legitimately round up
  // many venues); listing↔listing same-country is left to Listeo's nearby widget.
  const geo = geoMatchLevel(newPost, existingPost);
  if (geo === 'city') return 'topical';
  if (geo === 'country') {
    const newType = newPost.type || newPost.post_type || '';
    const existType = existingPost.type || existingPost.post_type || '';
    if (newType === 'post' || existType === 'post') return 'topical';
  }

  return 'none';
}

/**
 * Infer post type from slug/title when meta is missing.
 *
 * @param {object} post
 * @returns {string}
 */
function inferPostType(post) {
  const slug = (post.slug || '').toLowerCase();
  if (/best-.*-courts|best-.*-clubs|where-to-play/.test(slug)) return POST_TYPES.CITY_LISTICLE;
  if (/best-.*-rackets|best-.*-shoes|best-.*-bags/.test(slug)) return POST_TYPES.PRODUCT_LISTICLE;
  if (/padel-in-.*-\d{4}|guide-to-padel|padel-.*-guide/.test(slug)) return POST_TYPES.PILLAR;
  return POST_TYPES.CLUSTER;
}

// ---------------------------------------------------------------------------
// Mention opportunity detection
// ---------------------------------------------------------------------------

/**
 * Check if a sentence already contains a link to a given URL or slug.
 *
 * @param {string} html - Sentence HTML
 * @param {string} slug - Target post slug
 * @returns {boolean}
 */
function sentenceAlreadyLinksTo(html, slug) {
  if (!html || !slug) return false;
  const lower = html.toLowerCase();
  return lower.includes(`/${slug}/`) || lower.includes(`/${slug}"`);
}

/**
 * Check if an entire post body already links to a given slug.
 *
 * @param {string} bodyHtml - Full post body HTML
 * @param {string} slug - Target slug
 * @returns {boolean}
 */
function postAlreadyLinksTo(bodyHtml, slug) {
  if (!bodyHtml || !slug) return false;
  const lower = bodyHtml.toLowerCase();
  return lower.includes(`/${slug}/`) || lower.includes(`/${slug}"`);
}

/**
 * Split text into sentences (basic heuristic).
 *
 * @param {string} text - Plain text
 * @returns {string[]}
 */
function splitSentences(text) {
  // Split on period/question/exclamation followed by space+uppercase or end
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

/**
 * Find opportunities in an existing post to mention/link the new post.
 *
 * @param {object} newPost - Newly published post
 * @param {object} existingPost - Existing corpus post
 * @returns {Array<{paragraph_index: number, sentence: string, suggested_anchor: string, position: number}>}
 */
function findMentionOpportunities(newPost, existingPost) {
  const body = existingPost.content?.rendered || existingPost.content || '';
  if (!body) return [];

  const keyTerms = extractKeyTerms(newPost);
  if (keyTerms.length === 0) return [];

  // Extract paragraphs from raw HTML
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let match;
  while ((match = pRegex.exec(body)) !== null) {
    paragraphs.push(match[1]);
  }

  const opportunities = [];
  const newSlug = newPost.slug || '';

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const paraHtml = paragraphs[pIdx];

    // Skip if this paragraph already links to the new post
    if (sentenceAlreadyLinksTo(paraHtml, newSlug)) continue;

    const paraText = stripHtml(paraHtml);
    const sentences = splitSentences(paraText);

    for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
      const sentence = sentences[sIdx];
      const sentenceLower = sentence.toLowerCase();

      // Try each key term, longest first (most specific match wins)
      for (const term of keyTerms) {
        const termLower = term.toLowerCase();
        const pos = sentenceLower.indexOf(termLower);

        if (pos === -1) continue;

        // Found a mention — extract the actual casing from the sentence
        const actualText = sentence.substring(pos, pos + term.length);

        // Determine suggested anchor: use the matched text, but prefer
        // a slightly expanded version if it reads better
        const suggestedAnchor = buildAnchor(sentence, pos, term.length);

        opportunities.push({
          paragraph_index: pIdx,
          sentence,
          suggested_anchor: suggestedAnchor,
          position: pos,
          matched_term: term,
        });

        // Only one opportunity per sentence (the best/longest match)
        break;
      }
    }
  }

  // Deduplicate: max 3 opportunities per existing post
  return opportunities.slice(0, 3);
}

/**
 * Build anchor text from the sentence around the match position.
 * Tries to capture 2-5 words around the term for natural anchor text.
 *
 * @param {string} sentence
 * @param {number} pos - Start position of match
 * @param {number} len - Length of match
 * @returns {string}
 */
function buildAnchor(sentence, pos, len) {
  const matched = sentence.substring(pos, pos + len);

  // If matched text is 2+ words and <= 6 words, use it directly
  const wordCount = matched.trim().split(/\s+/).length;
  if (wordCount >= 2 && wordCount <= 6) return matched.trim();

  // If single word, try to grab surrounding context for a 2-4 word anchor
  const before = sentence.substring(0, pos);
  const after = sentence.substring(pos + len);

  const wordsBefore = before.trim().split(/\s+/).filter(Boolean);
  const wordsAfter = after.trim().split(/\s+/).filter(Boolean);

  // Grab 1 word before + match + 1 word after if available
  const parts = [];
  if (wordsBefore.length > 0) {
    const lastWord = wordsBefore[wordsBefore.length - 1];
    // Only prepend if it's a meaningful word (not "the", "a", etc.)
    if (lastWord.length > 2) parts.push(lastWord);
  }
  parts.push(matched.trim());
  if (wordsAfter.length > 0) {
    const firstWord = wordsAfter[0].replace(/[.,;:!?]$/, '');
    if (firstWord.length > 2) parts.push(firstWord);
  }

  const anchor = parts.join(' ');
  // Cap at 6 words
  const anchorWords = anchor.split(/\s+/);
  if (anchorWords.length > 6) return anchorWords.slice(0, 6).join(' ');

  return anchor;
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

/**
 * Score confidence of a proposal.
 *
 * @param {string} relationship
 * @param {object} opportunity
 * @returns {'high'|'medium'|'low'}
 */
function scoreConfidence(relationship, opportunity) {
  // Pillar-child or parent-child with a direct term match → high
  if (
    (relationship === 'pillar-child' || relationship === 'parent-child') &&
    opportunity.matched_term &&
    opportunity.matched_term.split(/\s+/).length >= 2
  ) {
    return 'high';
  }

  // Sibling with a multi-word match → high
  if (relationship === 'sibling' && opportunity.matched_term?.split(/\s+/).length >= 2) {
    return 'high';
  }

  // Pillar-child or sibling with single-word match → medium
  if (relationship === 'pillar-child' || relationship === 'sibling' || relationship === 'parent-child') {
    return 'medium';
  }

  // Topical with multi-word match → medium
  if (relationship === 'topical' && opportunity.matched_term?.split(/\s+/).length >= 2) {
    return 'medium';
  }

  // Everything else → low
  return 'low';
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

/**
 * Generate a proposal object from an opportunity.
 *
 * @param {object} existingPost - The post that would be edited
 * @param {object} opportunity - The mention opportunity
 * @param {object} newPost - The new post being linked to
 * @returns {object} Proposal object
 */
function generateProposal(existingPost, opportunity, newPost) {
  const relationship = classifyRelationship(newPost, existingPost);
  const newUrl = `/${newPost.slug}/`;
  const anchor = opportunity.suggested_anchor;
  const insert = `<a href="${newUrl}">${anchor}</a>`;

  // Build surrounding context
  const sentence = opportunity.sentence;
  const contextStart = Math.max(0, sentence.indexOf(anchor) - 60);
  const contextEnd = Math.min(sentence.length, sentence.indexOf(anchor) + anchor.length + 60);
  const context = '...' + sentence.substring(contextStart, contextEnd) + '...';

  const confidence = scoreConfidence(relationship, opportunity);

  const existingTitle = existingPost.title?.rendered
    ? stripHtml(existingPost.title.rendered)
    : existingPost.title || '';
  const newTitle = newPost.title?.rendered
    ? stripHtml(newPost.title.rendered)
    : newPost.title || '';

  // Build reason string
  let reason = '';
  if (relationship === 'pillar-child') {
    reason = `Existing pillar mentions "${opportunity.matched_term}" without linking to the new post`;
  } else if (relationship === 'sibling') {
    reason = `Sibling post under same pillar mentions "${opportunity.matched_term}" — cross-link strengthens cluster`;
  } else if (relationship === 'parent-child') {
    reason = `Parent/child relationship — "${opportunity.matched_term}" mention should link to new child post`;
  } else {
    reason = `Topically related post mentions "${opportunity.matched_term}" — contextual link opportunity`;
  }

  return {
    existing_post: {
      id: existingPost.id,
      slug: existingPost.slug,
      title: existingTitle,
      url: `/${existingPost.slug}/`,
      // CPT routing — 'post' or 'listing'. WP REST returns `type` on every item.
      post_type: existingPost.type || existingPost.post_type || 'post',
    },
    new_post: {
      id: newPost.id,
      slug: newPost.slug,
      title: newTitle,
      url: newUrl,
      post_type: newPost.type || newPost.post_type || 'post',
    },
    relationship,
    opportunity: {
      paragraph_index: opportunity.paragraph_index,
      sentence: opportunity.sentence,
      suggested_anchor: anchor,
      suggested_insert: insert,
      context,
    },
    confidence,
    reason,
    status: 'proposed',
  };
}

// ---------------------------------------------------------------------------
// Corpus scanning
// ---------------------------------------------------------------------------

/**
 * Scan the entire corpus for retrofit link opportunities toward the new post.
 *
 * @param {object} newPost - The newly published post
 * @param {object[]} corpus - All published posts
 * @returns {object[]} Array of proposal objects
 */
function scanCorpus(newPost, corpus) {
  const proposals = [];

  const newType = newPost.type || newPost.post_type || 'post';

  for (const existingPost of corpus) {
    // Never link a post to itself
    if (existingPost.id === newPost.id) continue;
    if (existingPost.slug === newPost.slug) continue;

    // listing → listing body links are OWNED by Listeo's "Other Clubs Near Me"
    // widget (rendered on every listing). Adding them here = the overlap/divergence
    // the linking decision explicitly forbids. The engine's listing-facing job is
    // INBOUND (blog/hub → listing) + listing → blog/hub — never listing → listing.
    // (LINKING-ARCHITECTURE-DECISION-2026-06-12, item 3.)
    const existType = existingPost.type || existingPost.post_type || 'post';
    if (newType === 'listing' && existType === 'listing') continue;

    // Check if it already links to the new post
    const body = existingPost.content?.rendered || existingPost.content || '';
    if (postAlreadyLinksTo(body, newPost.slug)) continue;

    // Classify relationship — skip 'none'
    const relationship = classifyRelationship(newPost, existingPost);
    if (relationship === 'none') continue;

    // Find mention opportunities
    const opportunities = findMentionOpportunities(newPost, existingPost);
    if (opportunities.length === 0) continue;

    // Generate proposals for each opportunity
    for (const opp of opportunities) {
      proposals.push(generateProposal(existingPost, opp, newPost));
    }
  }

  // Sort: high > medium > low, then by relationship strength
  const confOrder = { high: 0, medium: 1, low: 2 };
  const relOrder = { 'pillar-child': 0, 'parent-child': 1, sibling: 2, topical: 3 };

  proposals.sort((a, b) => {
    const confDiff = confOrder[a.confidence] - confOrder[b.confidence];
    if (confDiff !== 0) return confDiff;
    return (relOrder[a.relationship] || 4) - (relOrder[b.relationship] || 4);
  });

  return proposals;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Fetch all published posts from WordPress.
 *
 * @param {object} options
 * @param {number} [options.perPage=100] - Posts per page
 * @returns {Promise<object[]>} Array of WP post objects
 */
async function fetchCorpus(options = {}) {
  const perPage = options.perPage || 100;
  const cpts = ['posts', 'listing']; // both /posts (blog) AND /listing (CPT) are link targets/sources
  let all = [];
  for (const cpt of cpts) {
    let page = 1;
    while (true) {
      const batch = await wpGet(
        `/wp-json/wp/v2/${cpt}?per_page=${perPage}&page=${page}&status=publish`
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      // Ensure each item carries its type so applyProposals / generateProposal can route writes
      for (const it of batch) { if (!it.type) it.type = (cpt === 'posts' ? 'post' : 'listing'); }
      all = all.concat(batch);
      if (batch.length < perPage) break;
      page++;
    }
  }
  return all;
}

/**
 * Fetch region-hub pages as link targets.
 *
 * Region hubs are a `region` taxonomy ARCHIVE (not a CPT), so they never appear
 * in fetchCorpus. Each term's `link` field is already the live hub URL
 * (e.g. /clubs/ae/dubai/). We keep only CITY-level hubs (path /clubs/{cc}/{city}/,
 * i.e. 2 segments after /clubs/) because those are the pages a city blog should
 * point at; country-level hubs (/clubs/gb/) are too broad for a per-city link.
 *
 * Returns lightweight hub objects shaped like link targets:
 *   { id, name, slug, cc, city, count, url, type:'region-hub' }
 *
 * @param {object} [options]
 * @param {number} [options.perPage=100]
 * @returns {Promise<object[]>}
 */
async function fetchRegionHubs(options = {}) {
  const perPage = options.perPage || 100;
  const hubs = [];
  let page = 1;
  while (true) {
    let batch;
    try {
      batch = await wpGet(
        `/wp-json/wp/v2/region?per_page=${perPage}&page=${page}&hide_empty=true&_fields=id,name,slug,count,link,parent`
      );
    } catch {
      break; // taxonomy unavailable / paged past the end
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const t of batch) {
      const g = geoFromUrl(t.link || '');
      // Keep only city-level hubs (both cc AND city present in the URL).
      if (!g.cc || !g.city) continue;
      hubs.push({
        id: t.id,
        name: t.name,
        slug: t.slug,
        cc: g.cc,
        city: g.city,
        count: t.count || 0,
        url: t.link,
        type: 'region-hub',
      });
    }
    if (batch.length < perPage) break;
    page++;
  }
  return hubs;
}

/**
 * Build region-hub link proposals for a newly published BLOG post.
 *
 * A city/country guide (a /posts/ page) should point at the matching region hub
 * (topical authority) plus 1–2 flagship clubs in that city (specificity). This is
 * the blog → region-hub + flagship-club rule from the linking decision.
 *
 * We do NOT generate these for listings — a listing's nearby-club links are owned
 * by Listeo's widget, and a listing already sits under its region hub.
 *
 * @param {object} newPost - The newly published page (must be a blog post to qualify)
 * @param {object[]} regionHubs - From fetchRegionHubs()
 * @param {object[]} corpus - Full corpus (to pick flagship clubs in the same city)
 * @returns {object[]} Proposal objects (existing_post = the blog being edited)
 */
function proposeRegionHubLinks(newPost, regionHubs, corpus) {
  const newType = newPost.type || newPost.post_type || 'post';
  if (newType !== 'post') return []; // region-hub linking is a blog-only job

  const geo = inferGeo(newPost);
  if (!geo.city && !geo.cc) return [];

  const body = newPost.content?.rendered || newPost.content?.raw || newPost.content || '';
  const proposals = [];

  // 1. The matching city hub (preferred). Dedup by the hub's exact URL only —
  //    NOT by the bare city slug (a city blog's body is full of /clubs/{cc}/{city}/...
  //    listing links that share the slug, which would falsely mark the hub "already linked").
  let hub = null;
  if (geo.city) hub = regionHubs.find((h) => h.city === geo.city && (!geo.cc || h.cc === geo.cc));
  if (hub && !bodyLinksToUrl(body, hub.url)) {
    proposals.push(buildHubProposal(newPost, hub, body));
  }

  // 2. One or two flagship CLUBS in the same city (highest-signal venues).
  //    Restricted to /clubs/ listings — the `listing` CPT also holds coaches
  //    (/coaching/...), which are NOT clubs and must not be sold as "flagship clubs".
  //    Dedup by exact listing URL.
  if (geo.city) {
    const cityClubs = corpus.filter((p) => {
      const t = p.type || p.post_type || '';
      if (t !== 'listing') return false;
      const url = p.link || p.url || '';
      if (!/\/clubs\//.test(url)) return false; // clubs only — exclude coaches
      const g = inferGeo(p);
      return g.city === geo.city && (!geo.cc || g.cc === geo.cc);
    });
    // Link EVERY same-city club not already body-linked (no 2-club cap — decision
    // 2026-06-12: a city guide should point at all real venues in that city).
    // Order deterministically by title so output is stable across runs.
    const titleOf = (p) =>
      (p.title?.rendered ? stripHtml(p.title.rendered) : (p.title || p.slug || '')).toLowerCase();
    cityClubs.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
    for (const club of cityClubs) {
      const clubUrl = club.link || `/${club.slug}/`;
      if (bodyLinksToUrl(body, clubUrl)) continue;
      proposals.push(buildFlagshipClubProposal(newPost, club, body));
    }
  }

  return proposals;
}

/**
 * True if the body already has an <a href> pointing at EXACTLY this URL.
 * Matches the href as a complete attribute value (with/without trailing slash,
 * absolute or path-relative) — a substring check would wrongly flag a hub URL
 * like /clubs/gb/sheffield/ as "linked" just because a deeper listing URL
 * (/clubs/gb/sheffield/some-club/) contains it.
 */
function bodyLinksToUrl(body, url) {
  if (!body || !url) return false;
  const pathOnly = String(url).replace(/^https?:\/\/[^/]+/, '');
  const variants = new Set();
  for (const u of [url, pathOnly]) {
    if (!u) continue;
    const noSlash = u.replace(/\/$/, '');
    variants.add(`href="${u}"`);
    variants.add(`href="${noSlash}"`);
    variants.add(`href='${u}'`);
    variants.add(`href='${noSlash}'`);
  }
  for (const v of variants) {
    if (body.includes(v)) return true;
  }
  return false;
}

/**
 * Title-case a place / phrase for anchor text.
 * Capitalises each word's first letter, but keeps common small words
 * (in, of, the, and, on, at, by, for, to) lowercase UNLESS they are the
 * first word. Hyphenated/multi-word cities (e.g. "milton keynes",
 * "stoke-on-trent") are handled per token. Already-correct casing is
 * preserved for tokens that are not all-lowercase (e.g. acronyms).
 *
 * @param {string} str
 * @returns {string}
 */
function titleCasePhrase(str) {
  if (!str) return '';
  const small = new Set(['in', 'of', 'the', 'and', 'on', 'at', 'by', 'for', 'to', 'a', 'an']);
  const capWord = (w) =>
    w
      .split('-')
      .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
      .join('-');
  const words = str.trim().split(/\s+/);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      // Keep small words lowercase unless first word.
      if (i !== 0 && small.has(lower)) return lower;
      // Preserve tokens that already carry internal capitals (e.g. acronyms / "McLaren").
      if (w !== lower) return w;
      return capWord(lower);
    })
    .join(' ');
}

/** Build a proposal: blog → region hub. */
function buildHubProposal(newPost, hub, body) {
  const newTitle = newPost.title?.rendered ? stripHtml(newPost.title.rendered) : (newPost.title || '');
  // Title-case the anchor so it reads like every other (title-cased) link in the
  // body, e.g. "Padel Clubs in Sheffield" / "Padel Clubs in Milton Keynes" — not the
  // old lowercase "padel clubs in Sheffield". Target URL (hub.url) is unchanged.
  const anchor = `Padel Clubs in ${titleCasePhrase(hub.name)}`;
  return {
    existing_post: {
      id: newPost.id,
      slug: newPost.slug,
      title: newTitle,
      url: `/${newPost.slug}/`,
      post_type: 'post',
    },
    new_post: {
      id: hub.id,
      slug: hub.slug,
      title: hub.name,
      url: hub.url,
      post_type: 'region-hub',
    },
    relationship: 'region-hub',
    opportunity: {
      paragraph_index: -1,
      sentence: '',
      suggested_anchor: anchor,
      suggested_insert: `<a href="${hub.url}">${anchor}</a>`,
      context: `Blog "${newTitle}" → region hub ${hub.url} (${hub.count} clubs)`,
    },
    confidence: 'high',
    reason: `City/country guide should link to its region hub (${hub.count} clubs) for topical authority`,
    status: 'proposed',
    _link_target: 'related-reading', // appended to Related Reading, not inlined mid-sentence
  };
}

/** Build a proposal: blog → flagship club listing in the same city. */
function buildFlagshipClubProposal(newPost, club, body) {
  const newTitle = newPost.title?.rendered ? stripHtml(newPost.title.rendered) : (newPost.title || '');
  const clubTitle = club.title?.rendered ? stripHtml(club.title.rendered) : (club.title || club.slug);
  const clubUrl = club.link || `/${club.slug}/`;
  return {
    existing_post: {
      id: newPost.id,
      slug: newPost.slug,
      title: newTitle,
      url: `/${newPost.slug}/`,
      post_type: 'post',
    },
    new_post: {
      id: club.id,
      slug: club.slug,
      title: clubTitle,
      url: clubUrl,
      post_type: 'listing',
    },
    relationship: 'region-flagship',
    opportunity: {
      paragraph_index: -1,
      sentence: '',
      suggested_anchor: clubTitle,
      suggested_insert: `<a href="${clubUrl}">${clubTitle}</a>`,
      context: `Blog "${newTitle}" → flagship club ${clubUrl}`,
    },
    confidence: 'medium',
    reason: `Same-city flagship club — specificity link from the city guide to a real venue`,
    status: 'proposed',
    _link_target: 'related-reading',
  };
}

/**
 * Fetch a single post by slug. Checks /posts first, then /listing — the CPT is
 * embedded in the response's `type` field so callers can route writes.
 *
 * @param {string} slug
 * @returns {Promise<object|null>}
 */
async function fetchPostBySlug(slug) {
  const enc = encodeURIComponent(slug);
  for (const cpt of ['posts', 'listing']) {
    const results = await wpGet(`/wp-json/wp/v2/${cpt}?slug=${enc}&status=publish`);
    if (Array.isArray(results) && results.length > 0) {
      const hit = results[0];
      if (!hit.type) hit.type = (cpt === 'posts' ? 'post' : 'listing');
      return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Applying proposals
// ---------------------------------------------------------------------------

/**
 * Apply approved proposals by updating existing posts via WP REST API.
 *
 * For each approved proposal:
 * 1. Fetch the existing post's current content
 * 2. Find the target sentence in the body
 * 3. Replace the first occurrence of the anchor text with the linked version
 * 4. PUT the updated content back to WP
 *
 * SAFETY GATE (2026-06-12): writes are auto-applied ONLY when the edit-target page
 * (proposal.existing_post — the page that RECEIVES the link) is a BLOG post
 * (post_type === 'post'). Listing writes are DEFERRED by default because this engine
 * PUTs via the raw wpPut() helper, which does NOT carry the Listeo meta-wipe protection
 * that wp-payload.js applies (Listeo's save_post hook silently strips LISTEO_PROTECTED
 * meta on any bulk content write — see ~/Projects/padeli-notion/lib/wp-payload.js and
 * LINKING-ARCHITECTURE-DECISION-2026-06-12.md). The listing-write path is preserved but
 * gated behind options.allowListingWrites === true (default false).
 *
 * @param {object[]} approvedProposals - Proposals with status 'approved'
 * @param {object} [options]
 * @param {boolean} [options.allowListingWrites=false] - Permit writes to `listing` CPT
 *   pages. Leave false unless the caller has applied Listeo meta-wipe protection.
 * @returns {Promise<object[]>} Results array with { proposal, success, error? }.
 *   The array carries a non-enumerable-friendly `deferred` property and a
 *   `deferredListingWrites` count for listing proposals that were skipped.
 */
async function applyProposals(approvedProposals, options = {}) {
  const allowListingWrites = options.allowListingWrites === true;
  const results = [];
  const deferred = [];
  let deferredListingWrites = 0;

  for (const proposal of approvedProposals) {
    try {
      // SAFETY GATE: existing_post is the page being WRITTEN to (the link is inserted
      // into ITS body — verified in generateProposal/buildHubProposal/buildFlagshipClubProposal,
      // where existing_post is always the edit target). If that target is a `listing`,
      // defer unless explicitly allowed — the raw wpPut() here lacks Listeo meta-wipe
      // protection (LISTEO_PROTECTED) that wp-payload.js provides.
      if (proposal.existing_post.post_type === 'listing' && !allowListingWrites) {
        deferredListingWrites++;
        const entry = {
          proposal,
          reason: 'listing write deferred — needs LISTEO_PROTECTED meta-wipe protection per wp-payload.js; see LINKING-ARCHITECTURE-DECISION-2026-06-12.md',
        };
        deferred.push(entry);
        results.push({ proposal, success: false, deferred: true, error: entry.reason });
        console.log(
          `[retrofit-linker] DEFERRED listing write → "${proposal.existing_post.title}" (id ${proposal.existing_post.id}); needs Listeo meta-wipe protection`
        );
        continue;
      }

      // Route to the correct CPT endpoint: 'post' -> /wp/v2/posts/{id}, 'listing' -> /wp/v2/listing/{id}.
      // Previously hardcoded to /posts/, so any listing→listing or post→listing retrofit silently failed.
      const ept = (proposal.existing_post.post_type === 'listing') ? 'listing' : 'posts';
      const base = `/wp-json/wp/v2/${ept}/${proposal.existing_post.id}`;

      // Fetch fresh content
      const post = await wpGet(base);
      let content = post.content?.rendered || post.content?.raw || '';

      // If WP returns rendered content, we need the raw version
      // Try fetching with context=edit for raw content
      let rawContent;
      try {
        const editPost = await wpGet(`${base}?context=edit`);
        rawContent = editPost.content?.raw || content;
      } catch {
        rawContent = content;
      }

      const anchor = proposal.opportunity.suggested_anchor;
      const insert = proposal.opportunity.suggested_insert;
      const targetUrl = proposal.new_post.url || '';

      let replaced;
      if (proposal._link_target === 'related-reading') {
        // Region-hub / flagship-club links append to a Related Reading list rather
        // than splice mid-sentence (there's no natural anchor in the body). Idempotent:
        // skip if the target URL is already linked anywhere in the post.
        if (bodyLinksToUrl(rawContent, targetUrl)) {
          results.push({ proposal, success: false, error: `Already links to ${targetUrl}` });
          continue;
        }
        replaced = appendRelatedReadingItem(rawContent, insert);
      } else {
        // Find and replace the anchor text — only the first unlinked occurrence
        // Ensure we don't replace text that's already inside a link
        replaced = replaceUnlinkedText(rawContent, anchor, insert);
      }

      if (replaced === rawContent) {
        results.push({
          proposal,
          success: false,
          error: `Anchor text "${anchor}" not found in post body or already linked`,
        });
        continue;
      }

      // Update the post
      await wpPut(base, { content: replaced });

      proposal.status = 'applied';
      results.push({ proposal, success: true });
      console.log(
        `[retrofit-linker] Applied link in "${proposal.existing_post.title}" → "${proposal.new_post.title}"`
      );
    } catch (err) {
      results.push({
        proposal,
        success: false,
        error: err.message,
      });
      console.error(
        `[retrofit-linker] Failed to apply proposal for post ${proposal.existing_post.id}: ${err.message}`
      );
    }
  }

  // Surface deferred listing writes to the caller (count + collected entries with reasons).
  results.deferred = deferred;
  results.deferredListingWrites = deferredListingWrites;
  if (deferredListingWrites > 0) {
    console.log(`[retrofit-linker] Deferred ${deferredListingWrites} listing write(s) — re-run with allowListingWrites once Listeo meta-wipe protection is in place`);
  }

  return results;
}

/**
 * Append a link as a Related Reading list item.
 *
 * If the post already has a "Related Reading" <ul>, the new <li> is inserted before
 * its closing </ul>. Otherwise a fresh Gutenberg Related Reading block is appended at
 * the end. Used for region-hub / flagship-club links that have no inline anchor.
 *
 * @param {string} html - Post body HTML
 * @param {string} linkHtml - The <a href=...>...</a> to add
 * @returns {string} Updated HTML
 */
function appendRelatedReadingItem(html, linkHtml) {
  const item = `<li>${linkHtml}</li>`;

  // Case 1: a Related Reading list already exists → insert before its </ul>.
  const headingIdx = html.search(/Related Reading/i);
  if (headingIdx !== -1) {
    const ulOpen = html.indexOf('<ul', headingIdx);
    if (ulOpen !== -1) {
      const ulClose = html.indexOf('</ul>', ulOpen);
      if (ulClose !== -1) {
        return html.slice(0, ulClose) + item + '\n' + html.slice(ulClose);
      }
    }
  }

  // Case 2: no Related Reading section → append a fresh block.
  const section = [
    '',
    '<!-- wp:heading {"level":2} -->',
    '<h2 class="wp-block-heading">Related Reading</h2>',
    '<!-- /wp:heading -->',
    '',
    '<!-- wp:list -->',
    '<ul class="wp-block-list">',
    item,
    '</ul>',
    '<!-- /wp:list -->',
  ].join('\n');
  return html + '\n' + section + '\n';
}

/**
 * Replace the first unlinked occurrence of text in HTML body.
 * Skips occurrences that are already inside <a> tags.
 *
 * @param {string} html - Post HTML body
 * @param {string} anchor - Text to find
 * @param {string} replacement - HTML to replace with (includes <a> tag)
 * @returns {string} Updated HTML
 */
function replaceUnlinkedText(html, anchor, replacement) {
  if (!html || !anchor) return html;

  // Strategy: find all occurrences of the anchor text, skip any inside <a>...</a>
  const anchorLower = anchor.toLowerCase();
  const htmlLower = html.toLowerCase();

  let searchFrom = 0;
  while (true) {
    const idx = htmlLower.indexOf(anchorLower, searchFrom);
    if (idx === -1) return html; // Not found at all

    // Check if this occurrence is inside an <a> tag
    // Look backward for the nearest <a or </a>
    const beforeSlice = html.substring(0, idx);
    const lastOpenA = beforeSlice.lastIndexOf('<a ');
    const lastOpenA2 = beforeSlice.lastIndexOf('<a>');
    const lastCloseA = beforeSlice.lastIndexOf('</a>');
    const lastAOpen = Math.max(lastOpenA, lastOpenA2);

    const isInsideLink = lastAOpen > lastCloseA;

    if (isInsideLink) {
      // Skip this occurrence, search further
      searchFrom = idx + anchor.length;
      continue;
    }

    // Safe to replace — do it and return
    return html.substring(0, idx) + replacement + html.substring(idx + anchor.length);
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Build a markdown report from proposals.
 *
 * @param {object[]} proposals
 * @param {object} [meta] - Extra metadata (corpus size, etc.)
 * @returns {string} Markdown report
 */
function buildProposalReport(proposals, meta = {}) {
  const newPost = proposals[0]?.new_post || {};
  const lines = [];

  lines.push(`# Retrofit Link Report: ${newPost.slug || 'unknown'}`);
  lines.push('');
  lines.push(`**New post:** ${newPost.title || 'Unknown'} (${newPost.url || '/'})`);
  lines.push(`**Corpus scanned:** ${meta.corpusSize || '?'} posts`);
  lines.push(`**Proposals found:** ${proposals.length}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  const groups = {
    high: proposals.filter((p) => p.confidence === 'high'),
    medium: proposals.filter((p) => p.confidence === 'medium'),
    low: proposals.filter((p) => p.confidence === 'low'),
  };

  const sectionHeaders = {
    high: '## High confidence (recommended)',
    medium: '## Medium confidence (review)',
    low: '## Low confidence (optional)',
  };

  let counter = 1;

  for (const level of ['high', 'medium', 'low']) {
    const group = groups[level];
    if (group.length === 0) continue;

    lines.push(sectionHeaders[level]);
    lines.push('');

    for (const proposal of group) {
      const isRegion = proposal.relationship === 'region-hub' || proposal.relationship === 'region-flagship';
      lines.push(`### ${counter}. ${proposal.existing_post.title} (${proposal.existing_post.url})`);
      lines.push(`**Direction:** ${isRegion ? 'OUTBOUND (this page → target)' : 'INBOUND (this page → new page)'}`);
      lines.push(`**Relationship:** ${proposal.relationship}`);
      lines.push(`**Target:** ${proposal.new_post.title} (${proposal.new_post.url})`);
      lines.push(`**Reason:** ${proposal.reason}`);
      if (proposal.opportunity.sentence) {
        lines.push(`**Sentence:** "${proposal.opportunity.sentence}"`);
      } else {
        lines.push(`**Placement:** Related Reading list`);
      }
      lines.push(`**Suggested anchor:** "${proposal.opportunity.suggested_anchor}"`);
      lines.push(`**Insert:** \`${proposal.opportunity.suggested_insert}\``);
      lines.push('');
      counter++;
    }
  }

  if (proposals.length === 0) {
    lines.push('No retrofit link opportunities found.');
    lines.push('');
  }

  lines.push('---');
  lines.push('*Review proposals above. Approve by setting status to "approved" and re-running with --apply.*');

  return lines.join('\n');
}

/**
 * Save a proposal report to /tmp/.
 *
 * @param {string} report - Markdown report string
 * @param {string} slug - New post slug (used in filename)
 * @returns {string} Path to saved file
 */
function saveProposalReport(report, slug) {
  const filename = `retrofit-${slug}-${Date.now()}.md`;
  const filepath = path.join('/tmp', filename);
  fs.writeFileSync(filepath, report, 'utf8');
  console.log(`[retrofit-linker] Proposal report saved: ${filepath}`);
  return filepath;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full retrofit linker for a newly published post.
 *
 * @param {string} newPostSlug - Slug of the newly published post
 * @param {object} [options]
 * @param {object} [options.newPost] - Pre-fetched new post (skips WP fetch)
 * @param {object[]} [options.corpus] - Pre-fetched corpus (skips WP fetch)
 * @param {object[]} [options.regionHubs] - Pre-fetched region hubs (skips WP fetch)
 * @param {object[]} [options.approvedProposals] - Pre-approved proposals to apply
 * @param {boolean} [options.dryRun] - Build/return proposals but NEVER write to WP
 * @returns {Promise<{proposals: object[], applied: object[], report: string}>}
 */
async function retrofitLinks(newPostSlug, options = {}) {
  console.log(`[retrofit-linker] Starting retrofit scan for: ${newPostSlug}`);
  console.log(`[retrofit-linker] Mode: ${options.dryRun ? 'DRY-RUN (no writes)' : 'LIVE'}`);

  // 1. Fetch the new post
  let newPost = options.newPost || null;
  if (!newPost) {
    console.log('[retrofit-linker] Fetching new post from WP...');
    newPost = await fetchPostBySlug(newPostSlug);
    if (!newPost) {
      throw new Error(`Post not found for slug: ${newPostSlug}`);
    }
  }

  // 2. Fetch the corpus
  let corpus = options.corpus || null;
  if (!corpus) {
    console.log('[retrofit-linker] Fetching corpus from WP...');
    corpus = await fetchCorpus(options);
  }
  console.log(`[retrofit-linker] Corpus: ${corpus.length} published posts`);

  // 2b. Fetch region hubs (taxonomy archives — not in the corpus).
  let regionHubs = options.regionHubs || null;
  if (!regionHubs) {
    console.log('[retrofit-linker] Fetching region hubs...');
    regionHubs = await fetchRegionHubs(options);
  }
  console.log(`[retrofit-linker] Region hubs: ${regionHubs.length} city-level`);

  // 3. Scan corpus for INBOUND opportunities (existing pages → new page)
  console.log('[retrofit-linker] Scanning corpus for mention opportunities...');
  const inbound = scanCorpus(newPost, corpus);

  // 3b. Region-hub + flagship-club OUTBOUND links (new BLOG → hub + clubs).
  //     No-op for listings (their nearby links are Listeo-owned).
  const regionProposals = proposeRegionHubLinks(newPost, regionHubs, corpus);
  if (regionProposals.length > 0) {
    console.log(`[retrofit-linker] Region-hub/flagship proposals: ${regionProposals.length}`);
  }

  const proposals = [...inbound, ...regionProposals];
  console.log(`[retrofit-linker] Found ${proposals.length} proposals (${inbound.length} inbound, ${regionProposals.length} region)`);

  // 4. Build report
  const report = buildProposalReport(proposals, { corpusSize: corpus.length });

  // 5. Auto-approve high + medium confidence; low stays 'proposed' for manual review.
  // (Spec: SKILLS-SPEC §5 Tier-1 #2a, 2026-05-27.) Reviewers can still downgrade or
  // skip via the saved report when running review mode.
  for (const p of proposals) {
    if ((p.confidence === 'high' || p.confidence === 'medium') && p.status === 'proposed') {
      p.status = 'approved';
    }
  }
  const autoApprovedCount = proposals.filter(p => p.status === 'approved' && p.confidence !== 'low').length;
  if (autoApprovedCount > 0) console.log(`[retrofit-linker] Auto-approved ${autoApprovedCount} high+medium-confidence proposals`);

  // 6. Apply pre-approved proposals (unless dry-run)
  let applied = [];
  const toApply = options.approvedProposals || proposals.filter((p) => p.status === 'approved');

  if (options.dryRun) {
    console.log(`[retrofit-linker] DRY-RUN — ${toApply.length} proposals would be applied; NO writes performed`);
    const reportPath = saveProposalReport(report, newPostSlug);
    console.log(`[retrofit-linker] Report saved: ${reportPath}`);
  } else if (toApply.length > 0) {
    console.log(`[retrofit-linker] Applying ${toApply.length} approved proposals...`);
    applied = await applyProposals(toApply, { allowListingWrites: options.allowListingWrites === true });
    const successCount = applied.filter((r) => r.success).length;
    console.log(`[retrofit-linker] Applied ${successCount}/${toApply.length} proposals (deferred listing writes: ${applied.deferredListingWrites || 0})`);
  } else {
    console.log('[retrofit-linker] No approved proposals to apply — review report and approve proposals first');
    const reportPath = saveProposalReport(report, newPostSlug);
    console.log(`[retrofit-linker] Report saved: ${reportPath}`);
  }

  return { proposals, applied, report };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  retrofitLinks,
  scanCorpus,
  fetchCorpus,
  fetchRegionHubs,
  proposeRegionHubLinks,
  fetchPostBySlug,
  findMentionOpportunities,
  generateProposal,
  applyProposals,
  buildProposalReport,
  saveProposalReport,
  classifyRelationship,
  inferGeo,
  geoFromUrl,
  geoMatchLevel,
};
