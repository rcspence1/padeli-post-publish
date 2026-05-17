/**
 * Shared Utility Functions for Padeli
 *
 * Extracts duplicated helpers from discover-clubs.js, place-id-backfill.js,
 * qc-validator.js, and other modules so both the listing pipeline and blog
 * pipeline can share them.
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

// We import BANNED_PHRASES lazily inside cleanText to avoid circular deps
// (config.js requires wp-client.js, and some modules may require utils before config).
let _BANNED_PHRASES = null;

function getBannedPhrases() {
  if (!_BANNED_PHRASES) {
    _BANNED_PHRASES = require('./config').BANNED_PHRASES;
  }
  return _BANNED_PHRASES;
}

// ---------------------------------------------------------------------------
// String Similarity — Dice coefficient via bigram overlap
// (from discover-clubs.js + shell-creator.js)
// ---------------------------------------------------------------------------

/**
 * Calculate similarity between two strings using bigram overlap (Dice coefficient).
 * Returns a value between 0 (completely different) and 1 (identical).
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Similarity score 0-1
 */
function stringSimilarity(a, b) {
  if (!a || !b) return 0;

  const normalize = (s) => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const s1 = normalize(a);
  const s2 = normalize(b);

  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  const bigrams = (str) => {
    const map = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const pair = str.slice(i, i + 2);
      map.set(pair, (map.get(pair) || 0) + 1);
    }
    return map;
  };

  const map1 = bigrams(s1);
  const map2 = bigrams(s2);

  let intersection = 0;
  for (const [pair, count] of map1) {
    if (map2.has(pair)) {
      intersection += Math.min(count, map2.get(pair));
    }
  }

  return (2 * intersection) / (s1.length - 1 + s2.length - 1);
}

// ---------------------------------------------------------------------------
// UK Postcode Extraction (from discover-clubs.js)
// ---------------------------------------------------------------------------

/**
 * Extract a UK postcode from an address string.
 * Pattern: 1-2 uppercase letters, 1 digit, optional digit/letter, space, digit, 2 uppercase letters.
 *
 * @param {string} address - Address string to search
 * @returns {string|null} Extracted postcode (uppercased) or null
 */
function extractUKPostcode(address) {
  if (!address) return null;
  const match = address.match(/[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2}/i);
  return match ? match[0].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Normalise (from place-id-backfill.js)
// ---------------------------------------------------------------------------

/**
 * Lowercase a string and strip all non-alphanumeric characters (keep spaces).
 *
 * @param {string} s - Input string
 * @returns {string} Normalised string
 */
function normalise(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Word Count (from qc-validator.js)
// ---------------------------------------------------------------------------

/**
 * Count words in text, stripping HTML tags first.
 *
 * @param {string} text - Text or HTML string
 * @returns {number} Word count
 */
function countWords(text) {
  const cleaned = text.replace(/<[^>]*>/g, '').trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Strip HTML (from qc-validator.js)
// ---------------------------------------------------------------------------

/**
 * Strip all HTML tags from a string.
 *
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '');
}

// ---------------------------------------------------------------------------
// Extract Paragraphs (from qc-validator.js)
// ---------------------------------------------------------------------------

/**
 * Remove wp:html blocks from body HTML.
 * Used internally before paragraph extraction.
 *
 * @param {string} html - HTML string
 * @returns {string} HTML without wp:html blocks
 */
function stripWpHtmlBlocks(html) {
  return html.replace(/<!-- wp:html -->[\s\S]*?<!-- \/wp:html -->/g, '');
}

/**
 * Extract all <p> blocks from HTML (excluding wp:html schema blocks).
 * Returns array of { content, wordCount, index }.
 *
 * @param {string} html - HTML string containing Gutenberg blocks
 * @returns {Array<{content: string, wordCount: number, index: number}>}
 */
function extractParagraphs(html) {
  const cleaned = stripWpHtmlBlocks(html);
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let match;
  let idx = 0;
  while ((match = pRegex.exec(cleaned)) !== null) {
    const content = match[1];
    const words = countWords(content);
    if (words > 0) {
      paragraphs.push({ content, wordCount: words, index: idx });
      idx++;
    }
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// Clean Text (from qc-validator.js)
// ---------------------------------------------------------------------------

/**
 * Strip banned phrases and replace em/en dashes with " - ".
 * Cleans up double spaces left behind.
 *
 * @param {string} text - Input text
 * @returns {string} Cleaned text
 */
function cleanText(text) {
  let result = text;

  // Replace em/en dashes with " - "
  result = result.replace(/[\u2014\u2013]/g, ' - ');

  // Strip banned phrases (case-insensitive replacement)
  for (const phrase of getBannedPhrases()) {
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, '');
  }

  // Clean up double spaces left behind
  result = result.replace(/ {2,}/g, ' ').trim();

  return result;
}

// ---------------------------------------------------------------------------
// Slugify
// ---------------------------------------------------------------------------

/**
 * Convert text to a URL-safe slug.
 * Lowercases, replaces non-alphanumeric runs with hyphens, trims hyphens.
 *
 * @param {string} text - Input text
 * @returns {string} URL-safe slug
 */
function slugify(text) {
  return (text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------

/**
 * Promisified setTimeout for rate limiting.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  stringSimilarity,
  extractUKPostcode,
  normalise,
  countWords,
  stripHtml,
  extractParagraphs,
  cleanText,
  slugify,
  delay,
};
