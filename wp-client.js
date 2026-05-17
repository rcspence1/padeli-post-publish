/**
 * Centralized WordPress REST Client for Padeli
 *
 * Shared HTTP helpers for all modules that talk to the WP REST API.
 * Extracts duplicated auth, GET, POST, PUT, DELETE logic from
 * wp-payload.js, place-id-backfill.js, shell-creator.js, enrichment.js.
 *
 * Node.js v24+ (native fetch, no external deps) — CommonJS
 */

const SITE_URL = 'https://padeli.com';
const USER_AGENT = 'Mozilla/5.0 (PadeliPipeline)';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Read PADELI_WP_USER + PADELI_WP_APP_PASSWORD from env and return
 * a Base64-encoded Basic Auth string.
 *
 * @returns {string} Base64 auth string (ready for Authorization header)
 * @throws {Error} If either env var is missing
 */
function getWPAuth() {
  const user = process.env.PADELI_WP_USER;
  const pass = process.env.PADELI_WP_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('Missing PADELI_WP_USER or PADELI_WP_APP_PASSWORD env vars');
  }
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Shared headers
// ---------------------------------------------------------------------------

function baseHeaders() {
  return {
    'Authorization': `Basic ${getWPAuth()}`,
    'User-Agent': USER_AGENT,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * GET a WP REST endpoint with auth headers.
 *
 * @param {string} endpoint - Path starting with / (e.g. '/wp-json/wp/v2/listing/123')
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} On non-2xx status
 */
async function wpGet(endpoint) {
  const url = `${SITE_URL}${endpoint}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...baseHeaders(),
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WP GET ${endpoint} failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * POST to a WP REST endpoint with auth + JSON body.
 *
 * @param {string} endpoint - Path starting with /
 * @param {object} data - JSON body to send
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} On non-2xx status
 */
async function wpPost(endpoint, data) {
  const url = `${SITE_URL}${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WP POST ${endpoint} failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * PUT to a WP REST endpoint with auth + JSON body.
 *
 * @param {string} endpoint - Path starting with /
 * @param {object} data - JSON body to send
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} On non-2xx status
 */
async function wpPut(endpoint, data) {
  const url = `${SITE_URL}${endpoint}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...baseHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WP PUT ${endpoint} failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * DELETE a WP REST endpoint with auth headers.
 *
 * @param {string} endpoint - Path starting with /
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} On non-2xx status
 */
async function wpDelete(endpoint) {
  const url = `${SITE_URL}${endpoint}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      ...baseHeaders(),
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WP DELETE ${endpoint} failed (${res.status}): ${body}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  SITE_URL,
  getWPAuth,
  wpGet,
  wpPost,
  wpPut,
  wpDelete,
};
