// src/tools/analyst_momentum.js
// Main tool handler for AnalystMomentum
// Wires Finnhub + Alpha Vantage + FMP + velocity engine into one structured verdict

const axios = require("axios");
const { fetchRecommendationTrend } = require("../services/finnhub");
const { fetchAnalystSnapshot } = require("../services/alphavantage");
const { get, set } = require("../utils/cache");
const {
  computeVelocity,
  calcBullishRatio,
  computePercentileOfHistory,
  computePriceTargetMetrics,
} = require("../utils/velocity");

//  FMP Price Target + Finnhub Current Price

const FMP_KEY = process.env.FMP_API_KEY;

/**
 * Fetch price target consensus from FMP stable endpoint
 * Fetch current price from Finnhub /quote (free tier, confirmed working)
 * Cached for 6 hours to avoid FMP rate limits on free tier
 * Used to compute priceTargetDelta and priceTargetDispersion
 */
async function fetchPriceTargetData(ticker) {
  const cacheKey = `fmp:pricetarget:${ticker}`;
  const cached = get(cacheKey);
  if (cached) {
    console.log(`[FMP] Cache hit for ${ticker} price target`);
    return cached;
  }

  try {
    const [ptRes, quoteRes] = await Promise.allSettled([
      axios.get(`https://financialmodelingprep.com/stable/price-target-consensus?symbol=${ticker}&apikey=${FMP_KEY}`, { timeout: 10000 }),
      axios.get(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`, { timeout: 10000 }),
    ]);

    const ptRaw    = ptRes.status    === "fulfilled" ? ptRes.value.data    : null;
    const quoteRaw = quoteRes.status === "fulfilled" ? quoteRes.value.data : null;

    // FMP stable returns an array
    const pt = Array.isArray(ptRaw) ? ptRaw[0] : ptRaw;
    if (!pt || !pt.targetConsensus) {
      console.warn(`[FMP] No price target data for ${ticker}`);
      return null;
    }

    // Finnhub quote: c = current price
    const currentPrice = quoteRaw && quoteRaw.c ? quoteRaw.c : null;

    const data = {
      targetHighPrice:   pt.targetHigh      || null,
      targetLowPrice:    pt.targetLow       || null,
      targetMeanPrice:   pt.targetConsensus || null,
      targetMedianPrice: pt.targetMedian    || null,
      currentPrice,
    };

    // Cache for 6 hours — price targets don't change that frequently
    set(cacheKey, data, 6 * 60 * 60 * 1000);
    console.log(`[FMP] Price target for ${ticker} — mean: ${data.targetMeanPrice}, current: ${data.currentPrice}`);
    return data;

  } catch (err) {
    console.warn(`[FMP] Price target fetch failed for ${ticker}: ${err.message}`);
    return null;
  }
}

// Core function — called by all 8 MCP tools

async function getAnalystMomentum(ticker) {
  const symbol = ticker.toUpperCase().trim();

  // Fetch all sources in parallel for speed
  const [finnhubResult, avResult, ptResult] = await Promise.allSettled([
    fetchRecommendationTrend(symbol),
    fetchAnalystSnapshot(symbol),
    fetchPriceTargetData(symbol),
  ]);

  // Finnhub is primary — fail hard if it's down
  if (finnhubResult.status === "rejected") {
    throw new Error(`Failed to fetch Finnhub data for ${symbol}: ${finnhubResult.reason}`);
  }

  const months   = finnhubResult.value;
  const snapshot = avResult.status === "fulfilled" ? avResult.value : null;
  const ptData   = ptResult.status  === "fulfilled" ? ptResult.value : null;

  // Run monthly velocity engine on Finnhub data
  const velocity = computeVelocity(symbol, months);

  // Build current consensus from Finnhub latest month
  const latestMonth = months[0];
  const { bullishRatio, bearishRatio, bullishCount, bearishCount, total } = calcBullishRatio(latestMonth);

  const currentConsensus = {
    strongBuy:     latestMonth.strongBuy  || 0,
    buy:           latestMonth.buy        || 0,
    hold:          latestMonth.hold       || 0,
    sell:          latestMonth.sell       || 0,
    strongSell:    latestMonth.strongSell || 0,
    totalAnalysts: total,
    bullishRatio,
    bearishRatio,
  };

  // Price target — prefer FMP consensus, fall back to Alpha Vantage
  let analystTargetPrice = null;
  if (ptData && ptData.targetMeanPrice) {
    analystTargetPrice = ptData.targetMeanPrice;
  } else if (snapshot && snapshot.analystTargetPrice) {
    analystTargetPrice = snapshot.analystTargetPrice;
  }

  // Compute price target metrics and percentile of available history
  const { priceTargetDelta, priceTargetDispersion } = computePriceTargetMetrics(ptData);
  const percentileOfHistory = computePercentileOfHistory(bullishRatio, velocity.monthlyTrend);

  // Confidence
  let confidence = 0.88;
  if (!snapshot) confidence -= 0.05;
  if (!ptData)   confidence -= 0.03;
  if (months.length < 3) confidence -= 0.10;
  confidence = parseFloat(Math.max(0.5, confidence).toFixed(2));

  // Build sourceRefs dynamically
  const sourceRefs = [
    "Finnhub Stock Recommendation API — free tier, monthly consensus",
    snapshot
      ? "Alpha Vantage OVERVIEW API — free tier, current analyst snapshot"
      : "Alpha Vantage — unavailable for this query",
  ];
  if (ptData) {
    sourceRefs.push("Financial Modeling Prep Price Target API — free tier, consensus price target high/low/mean");
    sourceRefs.push("Finnhub Quote API — free tier, current price for delta computation");
  }

  return {
    ticker:               symbol,
    oneShotVerdict:       velocity.oneShotVerdict,
    velocityScore:        velocity.velocityScore,
    velocityRegime:       velocity.velocityRegime,
    acceleration:         velocity.acceleration,
    currentConsensus,
    analystTargetPrice,
    monthlyTrend:         velocity.monthlyTrend,
    netRevisionRatio:     velocity.netRevisionRatio,
    priceTargetDelta,
    priceTargetDispersion,
    percentileOfHistory,
    sourceRefs,
    asOf:          new Date().toISOString().substring(0, 10),
    confidence,
    freshnessNote:
      "Finnhub data updates monthly. Alpha Vantage updates daily. " +
      "FMP price target updates daily. Finnhub quote updates in real-time. " +
      "Velocity score reflects 4-5 month monthly consensus trend.",
  };
}

module.exports = { getAnalystMomentum };