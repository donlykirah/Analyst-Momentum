// src/services/alphavantage.js
// Fetches current analyst consensus snapshot and price target
// Endpoint: /query?function=OVERVIEW
// Returns: current analyst rating breakdown + target price
// Free tier — register at alphavantage.co for free key

const fetch = require("node-fetch");
const { get, set } = require("../utils/cache");

const BASE_URL = "https://www.alphavantage.co/query";

// Alpha Vantage OVERVIEW updates daily — cache for 24 hours
const AV_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch current analyst consensus from Alpha Vantage OVERVIEW endpoint
 * Returns analyst rating breakdown and price target
 */
async function fetchAnalystSnapshot(ticker) {
  const cacheKey = `alphavantage:overview:${ticker.toUpperCase()}`;
  const cached = get(cacheKey);
  if (cached) {
    console.log(`[AlphaVantage] Cache hit for ${ticker}`);
    return cached;
  }

  const url = `${BASE_URL}?function=OVERVIEW&symbol=${ticker.toUpperCase()}&apikey=${process.env.ALPHAVANTAGE_API_KEY}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Alpha Vantage API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Alpha Vantage returns empty object or Note field if rate limited or invalid
  if (!data || data.Note || data["Error Message"] || !data.Symbol) {
    console.warn(`[AlphaVantage] No valid data for ${ticker} — may be rate limited or invalid ticker`);
    return null;
  }

  const snapshot = {
    ticker: data.Symbol,
    analystTargetPrice: data.AnalystTargetPrice ? parseFloat(data.AnalystTargetPrice) : null,
    analystRatings: {
      strongBuy:  parseInt(data.AnalystRatingStrongBuy  || "0", 10),
      buy:        parseInt(data.AnalystRatingBuy        || "0", 10),
      hold:       parseInt(data.AnalystRatingHold       || "0", 10),
      sell:       parseInt(data.AnalystRatingSell       || "0", 10),
      strongSell: parseInt(data.AnalystRatingStrongSell || "0", 10),
    },
    sector:   data.Sector   || null,
    industry: data.Industry || null,
  };

  // Cache for 24 hours
  set(cacheKey, snapshot, AV_TTL_MS);

  console.log(`[AlphaVantage] Fetched snapshot for ${ticker} — target price: ${snapshot.analystTargetPrice}`);
  return snapshot;
}

module.exports = { fetchAnalystSnapshot };