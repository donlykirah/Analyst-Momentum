// src/services/finnhub.js
// Fetches monthly analyst recommendation trend from Finnhub free tier
// Endpoint: /api/v1/stock/recommendation
// Returns: 4-5 months of buy/strongBuy/hold/sell/strongSell counts
// Free tier — no paid plan required

const axios = require("axios");
const { get, set } = require("../utils/cache");

const BASE_URL = "https://finnhub.io/api/v1";

/**
 * Fetch monthly recommendation trend for a ticker
 * Returns array sorted newest first (Finnhub default)
 */
async function fetchRecommendationTrend(ticker) {
  const cacheKey = `finnhub:recommendation:${ticker.toUpperCase()}`;
  const cached = get(cacheKey);
  if (cached) {
    console.log(`[Finnhub] Cache hit for ${ticker}`);
    return cached;
  }

  const url = `${BASE_URL}/stock/recommendation?symbol=${ticker.toUpperCase()}&token=${process.env.FINNHUB_API_KEY}`;

  const response = await axios.get(url);

  if (!response.data) {
    throw new Error("Finnhub API error");
  }

  const data = response.data;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No recommendation data available for ${ticker}`);
  }

  // Sort newest first (Finnhub already does this but enforce it)
  const sorted = data.sort((a, b) => new Date(b.period) - new Date(a.period));

  // Cache for 6 hours — data updates monthly so this is very conservative
  set(cacheKey, sorted);

  console.log(`[Finnhub] Fetched ${sorted.length} months of data for ${ticker}`);
  return sorted;
}

module.exports = { fetchRecommendationTrend };