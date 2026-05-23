// src/tools/analyst_momentum.js
// Main tool handler for AnalystMomentum
// Wires Finnhub + Alpha Vantage + Yahoo Finance + velocity engine into one structured verdict

const axios = require("axios");
const { fetchRecommendationTrend } = require("../services/finnhub");
const { fetchAnalystSnapshot } = require("../services/alphavantage");
const {
  computeVelocity,
  calcBullishRatio,
  computeVelocityFromEvents,
  blendVelocityScores,
  computePercentile,
  computePriceTargetMetrics,
} = require("../utils/velocity");

// ─── Inline Yahoo Finance fetchers (free, no API key required) ───────────────

const YF_BASE = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "application/json",
};

/**
 * Fetch individual analyst upgrade/downgrade events from Yahoo Finance
 * Returns array sorted newest first
 * Works reliably from server environments (Render) — may be blocked on local/residential IPs
 */
async function fetchYahooEvents(ticker) {
  try {
    const url = `${YF_BASE}/${ticker}?modules=upgradeDowngradeHistory`;
    const res = await axios.get(url, { headers: YF_HEADERS, timeout: 8000 });
    const history = res.data?.quoteSummary?.result?.[0]?.upgradeDowngradeHistory?.history || [];
    return history.sort((a, b) => b.epochGradeDate - a.epochGradeDate);
  } catch (err) {
    console.warn(`[Yahoo] Events fetch failed for ${ticker}: ${err.message}`);
    return []; // Non-fatal — degrades gracefully
  }
}

/**
 * Fetch price target high/low/mean and current price from Yahoo Finance
 * Used to compute priceTargetDelta and priceTargetDispersion
 * Works reliably from server environments (Render) — may be blocked on local/residential IPs
 */
async function fetchYahooPriceTargets(ticker) {
  try {
    const url = `${YF_BASE}/${ticker}?modules=financialData`;
    const res = await axios.get(url, { headers: YF_HEADERS, timeout: 8000 });
    const fd = res.data?.quoteSummary?.result?.[0]?.financialData;
    if (!fd) return null;
    return {
      targetHighPrice:   fd.targetHighPrice?.raw   || null,
      targetLowPrice:    fd.targetLowPrice?.raw    || null,
      targetMeanPrice:   fd.targetMeanPrice?.raw   || null,
      targetMedianPrice: fd.targetMedianPrice?.raw || null,
      currentPrice:      fd.currentPrice?.raw      || null,
    };
  } catch (err) {
    console.warn(`[Yahoo] Price target fetch failed for ${ticker}: ${err.message}`);
    return null; // Non-fatal — degrades gracefully
  }
}

// ─── Core function — called by all 8 MCP tools ───────────────────────────────

/**
 * Core function — called by all 8 MCP tools
 * Fetches from all three sources in parallel and returns complete intelligence object
 */
async function getAnalystMomentum(ticker) {
  const symbol = ticker.toUpperCase().trim();

  // Fetch all sources in parallel for speed
  // Yahoo Finance failures are non-fatal — tool still works on Finnhub + AV alone
  const [finnhubResult, avResult, yahooEventsResult, yahooPtResult] = await Promise.allSettled([
    fetchRecommendationTrend(symbol),
    fetchAnalystSnapshot(symbol),
    fetchYahooEvents(symbol),
    fetchYahooPriceTargets(symbol),
  ]);

  // Finnhub is primary — fail hard if it's down
  if (finnhubResult.status === "rejected") {
    throw new Error(`Failed to fetch Finnhub data for ${symbol}: ${finnhubResult.reason}`);
  }

  const months   = finnhubResult.value;
  const snapshot = avResult.status === "fulfilled"          ? avResult.value          : null;
  const events   = yahooEventsResult.status === "fulfilled" ? yahooEventsResult.value : [];
  const ptData   = yahooPtResult.status === "fulfilled"     ? yahooPtResult.value     : null;

  // Run monthly velocity engine on Finnhub data (unchanged)
  const velocity = computeVelocity(symbol, months);

  // Run event-based velocity from Yahoo Finance individual upgrade/downgrade events
  const eventVelocity = computeVelocityFromEvents(events);

  // Blend: 60% event-based + 40% monthly when events exist, else monthly only
  const blendedVelocityScore = blendVelocityScores(velocity.velocityScore, eventVelocity.eventVelocityScore);

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

  // Price target — prefer Yahoo mean (more granular), fall back to Alpha Vantage
  let analystTargetPrice = null;
  if (ptData && ptData.targetMeanPrice) {
    analystTargetPrice = ptData.targetMeanPrice;
  } else if (snapshot && snapshot.analystTargetPrice) {
    analystTargetPrice = snapshot.analystTargetPrice;
  }

  // Compute new fields
  const { priceTargetDelta, priceTargetDispersion } = computePriceTargetMetrics(ptData);
  const percentile3yr = computePercentile(bullishRatio, velocity.monthlyTrend);

  // Confidence: lower if secondary sources failed
  let confidence = 0.88;
  if (!snapshot)           confidence -= 0.05;
  if (events.length === 0) confidence -= 0.05;
  if (!ptData)             confidence -= 0.03;
  if (months.length < 3)   confidence -= 0.10;
  confidence = parseFloat(Math.max(0.5, confidence).toFixed(2));

  // Build sourceRefs dynamically based on what succeeded
  const sourceRefs = [
    "Finnhub Stock Recommendation API — free tier, monthly consensus",
    snapshot
      ? "Alpha Vantage OVERVIEW API — free tier, current analyst snapshot"
      : "Alpha Vantage — unavailable for this query",
  ];
  if (events.length > 0) {
    sourceRefs.push("Yahoo Finance upgradeDowngradeHistory — free tier, individual analyst events");
  }
  if (ptData) {
    sourceRefs.push("Yahoo Finance financialData — free tier, price target high/low/mean");
  }

  return {
    ticker:               symbol,
    oneShotVerdict:       velocity.oneShotVerdict,
    velocityScore:        blendedVelocityScore,
    velocityRegime:       velocity.velocityRegime,
    acceleration:         velocity.acceleration,
    currentConsensus,
    analystTargetPrice,
    monthlyTrend:         velocity.monthlyTrend,
    netRevisionRatio:     velocity.netRevisionRatio,
    upgrades60d:          eventVelocity.upgrades60d,
    leadingFirm:          eventVelocity.leadingFirm,
    priceTargetDelta,
    priceTargetDispersion,
    percentile3yr,
    sourceRefs,
    asOf:          new Date().toISOString().substring(0, 10),
    confidence,
    freshnessNote:
      "Finnhub data updates monthly. Alpha Vantage updates daily. " +
      "Yahoo Finance events update in near real-time. " +
      "Velocity score blends 60-day individual events (60%) with 4-5 month monthly trend (40%).",
  };
}

module.exports = { getAnalystMomentum };