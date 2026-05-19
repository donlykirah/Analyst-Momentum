// src/utils/cache.js
// Simple in-memory cache with TTL
// No Redis needed — Finnhub updates monthly, Alpha Vantage daily
// 6-hour TTL is more than sufficient

const cache = new Map();

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function clear() {
  cache.clear();
}

module.exports = { get, set, clear };