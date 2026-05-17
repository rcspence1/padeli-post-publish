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
    },
    new_post: {
      id: newPost.id,
      slug: newPost.slug,
      title: newTitle,
      url: newUrl,
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

  for (const existingPost of corpus) {
    // Never link a post to itself
    if (existingPost.id === newPost.id) continue;
    if (existingPost.slug === newPost.slug) continue;

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
  let page = 1;
  let allPosts = [];

  while (true) {
    const batch = await wpGet(
      `/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&status=publish`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    allPosts = allPosts.concat(batch);
    if (batch.length < perPage) break;
    page++;
  }

  return allPosts;
}

/**
 * Fetch a single post by slug.
 *
 * @param {string} slug
 * @returns {Promise<object|null>}
 */
async function fetchPostBySlug(slug) {
  const results = await wpGet(
    `/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=publish`
  );
  if (Array.isArray(results) && results.length > 0) return results[0];
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
 * @param {object[]} approvedProposals - Proposals with status 'approved'
 * @param {object} options
 * @returns {Promise<object[]>} Results array with { proposal, success, error? }
 */
async function applyProposals(approvedProposals) {
  const results = [];

  for (const proposal of approvedProposals) {
    try {
      // Fetch fresh content
      const post = await wpGet(
        `/wp-json/wp/v2/posts/${proposal.existing_post.id}`
      );
      let content = post.content?.rendered || post.content?.raw || '';

      // If WP returns rendered content, we need the raw version
      // Try fetching with context=edit for raw content
      let rawContent;
      try {
        const editPost = await wpGet(
          `/wp-json/wp/v2/posts/${proposal.existing_post.id}?context=edit`
        );
        rawContent = editPost.content?.raw || content;
      } catch {
        rawContent = content;
      }

      const anchor = proposal.opportunity.suggested_anchor;
      const insert = proposal.opportunity.suggested_insert;

      // Find and replace the anchor text — only the first unlinked occurrence
      // Ensure we don't replace text that's already inside a link
      const replaced = replaceUnlinkedText(rawContent, anchor, insert);

      if (replaced === rawContent) {
        results.push({
          proposal,
          success: false,
          error: `Anchor text "${anchor}" not found in post body or already linked`,
        });
        continue;
      }

      // Update the post
      await wpPut(`/wp-json/wp/v2/posts/${proposal.existing_post.id}`, {
        content: replaced,
      });

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

  return results;
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
      lines.push(`### ${counter}. ${proposal.existing_post.title} (${proposal.existing_post.url})`);
      lines.push(`**Relationship:** ${proposal.relationship}`);
      lines.push(`**Reason:** ${proposal.reason}`);
      lines.push(`**Sentence:** "${proposal.opportunity.sentence}"`);
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
 * @param {object[]} [options.approvedProposals] - Pre-approved proposals to apply
 * @returns {Promise<{proposals: object[], applied: object[], report: string}>}
 */
async function retrofitLinks(newPostSlug, options = {}) {
  console.log(`[retrofit-linker] Starting retrofit scan for: ${newPostSlug}`);
  console.log('[retrofit-linker] Mode: LIVE');

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

  // 3. Scan corpus for opportunities
  console.log('[retrofit-linker] Scanning corpus for mention opportunities...');
  const proposals = scanCorpus(newPost, corpus);
  console.log(`[retrofit-linker] Found ${proposals.length} proposals`);

  // 4. Build report
  const report = buildProposalReport(proposals, { corpusSize: corpus.length });

  // 5. Apply pre-approved proposals
  let applied = [];
  const toApply = options.approvedProposals || proposals.filter((p) => p.status === 'approved');

  if (toApply.length > 0) {
    console.log(`[retrofit-linker] Applying ${toApply.length} approved proposals...`);
    applied = await applyProposals(toApply);
    const successCount = applied.filter((r) => r.success).length;
    console.log(`[retrofit-linker] Applied ${successCount}/${toApply.length} proposals`);
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
  findMentionOpportunities,
  generateProposal,
  applyProposals,
  buildProposalReport,
  saveProposalReport,
  classifyRelationship,
};
