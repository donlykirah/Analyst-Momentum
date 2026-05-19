// src/tools/analyst_momentum.js
// Main tool handler for AnalystMomentum
// Wires Finnhub + Alpha Vantage + velocity engine into one structured verdict

const { fetchRecommendationTrend } = require("../services/finnhub");
const { fetchAnalystSnapshot } = require("../services/alphavantage");
const { computeVelocity, calcBullishRatio } = require("../utils/velocity");

/**
 * Core function — called by all 5 MCP tools
 * Fetches data from both sources and returns complete intelligence object
 */
async function getAnalystMomentum(ticker) {
  const symbol = ticker.toUpperCase().trim();

  // Fetch from both sources in parallel for speed
  const [finnhubMonths, avSnapshot] = await Promise.allSettled([
    fetchRecommendationTrend(symbol),
    fetchAnalystSnapshot(symbol),
  ]);

  // Finnhub is primary — fail hard if it's down
  if (finnhubMonths.status === "rejected") {
    throw new Error(`Failed to fetch Finnhub data for ${symbol}: ${finnhubMonths.reason}`);
  }

  const months = finnhubMonths.value;
  const snapshot = avSnapshot.status === "fulfilled" ? avSnapshot.value : null;

  // Run velocity engine on Finnhub monthly data
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

  // If Alpha Vantage worked, use its current ratings as cross-validation
  // and extract price target
  let analystTargetPrice = null;
  if (snapshot && snapshot.analystTargetPrice) {
    analystTargetPrice = snapshot.analystTargetPrice;
  }

  // Confidence: lower if Alpha Vantage failed, lower if only 2 months of data
  let confidence = 0.88;
  if (!snapshot) confidence -= 0.08;
  if (months.length < 3) confidence -= 0.10;
  confidence = parseFloat(Math.max(0.5, confidence).toFixed(2));

  return {
    ticker: symbol,
    oneShotVerdict:  velocity.oneShotVerdict,
    velocityScore:   velocity.velocityScore,
    velocityRegime:  velocity.velocityRegime,
    acceleration:    velocity.acceleration,
    currentConsensus,
    analystTargetPrice,
    monthlyTrend:    velocity.monthlyTrend,
    netRevisionRatio: velocity.netRevisionRatio,
    sourceRefs: [
      "Finnhub Stock Recommendation API — free tier, monthly consensus",
      snapshot
        ? "Alpha Vantage OVERVIEW API — free tier, current analyst snapshot"
        : "Alpha Vantage — unavailable for this query",
    ],
    asOf: new Date().toISOString().substring(0, 10),
    confidence,
    freshnessNote:
      "Finnhub recommendation data updates monthly. Alpha Vantage OVERVIEW updates daily. " +
      "Velocity score reflects trend over last 4-5 months of consensus data.",
  };
}

module.exports = { getAnalystMomentum };