// src/utils/velocity.js
// Core calculation engine for AnalystMomentum
// Computes velocity score, acceleration, and regime from monthly consensus data

/**
 * Calculate bullish ratio for a single month
 * bullishRatio = (buy + strongBuy) / totalAnalysts
 */
function calcBullishRatio(month) {
  const bullishCount = (month.buy || 0) + (month.strongBuy || 0);
  const bearishCount = (month.sell || 0) + (month.strongSell || 0);
  const total = bullishCount + bearishCount + (month.hold || 0);
  if (total === 0) return { bullishRatio: 0, bearishRatio: 0, bullishCount, bearishCount, total };
  return {
    bullishRatio: parseFloat((bullishCount / total).toFixed(4)),
    bearishRatio: parseFloat((bearishCount / total).toFixed(4)),
    bullishCount,
    bearishCount,
    total,
  };
}

/**
 * Compute velocity score 0-100
 * Measures how much bullishRatio changed from oldest to latest month
 * Multiplier of 250 means a 0.4 shift (large) = 100 score
 */
function calcVelocityScore(latestRatio, oldestRatio) {
  const rawDelta = latestRatio - oldestRatio;
  const score = Math.min(100, Math.max(0, Math.round(Math.abs(rawDelta) * 250)));
  return { velocityScore: score, rawDelta };
}

/**
 * Compute acceleration
 * Positive = pace speeding up, Negative = pace slowing down
 */
function calcAcceleration(ratios) {
  if (ratios.length < 3) return { accelerationDelta: 0, accelerationLabel: "Insufficient data" };
  const recentDelta = ratios[0] - ratios[1];   // latest vs prev
  const olderDelta  = ratios[1] - ratios[2];   // prev vs prev-prev
  const accelerationDelta = parseFloat((recentDelta - olderDelta).toFixed(4));

  let accelerationLabel;
  if (accelerationDelta > 0.02) accelerationLabel = "Positive — pace speeding up";
  else if (accelerationDelta < -0.02) accelerationLabel = "Negative — pace slowing down";
  else accelerationLabel = "Steady — pace unchanged";

  return { accelerationDelta, accelerationLabel };
}

/**
 * Classify regime based on bullishRatio level and velocity direction
 *
 * Stale        — barely any movement in either direction
 * Awakening    — bullish sentiment slowly improving
 * Accelerating — bullish sentiment rising fast with positive acceleration
 * Peak         — bullish ratio high but momentum decelerating
 * Decelerating — sell-side turning more bearish (ratio falling)
 */
function classifyRegime(latestRatio, rawDelta, accelerationDelta) {
  if (rawDelta < -0.05) return "Decelerating";
  if (Math.abs(rawDelta) < 0.05) return "Stale";
  if (rawDelta >= 0.05 && rawDelta < 0.15) return "Awakening";
  if (rawDelta >= 0.15 && accelerationDelta >= 0) return "Accelerating";
  if (rawDelta >= 0.15 && accelerationDelta < 0) return "Peak";
  return "Stale";
}

/**
 * Generate plain-English one-shot verdict
 */
function buildVerdict(ticker, regime, velocityScore, latestRatio) {
  const bullishPct = Math.round(latestRatio * 100);
  switch (regime) {
    case "Accelerating":
      return `Sell-side is ACCELERATING bullish on ${ticker} — ${bullishPct}% of analysts are bullish and momentum is building fast (velocity score ${velocityScore}/100)`;
    case "Peak":
      return `Sell-side is PEAK bullish on ${ticker} — ${bullishPct}% of analysts are bullish but momentum is beginning to slow (velocity score ${velocityScore}/100)`;
    case "Awakening":
      return `Sell-side is AWAKENING bullish on ${ticker} — ${bullishPct}% of analysts are bullish with steady early momentum (velocity score ${velocityScore}/100)`;
    case "Decelerating":
      return `Sell-side is DECELERATING on ${ticker} — bullish consensus is fading, ${bullishPct}% still bullish but trend is reversing (velocity score ${velocityScore}/100)`;
    case "Stale":
    default:
      return `Sell-side is STALE on ${ticker} — ${bullishPct}% of analysts are bullish with no significant momentum shift (velocity score ${velocityScore}/100)`;
  }
}

/**
 * Main calculation engine
 * Takes raw Finnhub monthly array (sorted newest first)
 * Returns complete velocity intelligence object
 */
function computeVelocity(ticker, finnhubMonths) {
  if (!finnhubMonths || finnhubMonths.length === 0) {
    throw new Error("No monthly data available for velocity calculation");
  }

  // Build enriched monthly trend (newest first)
  const monthlyTrend = finnhubMonths.map((month) => {
    const { bullishRatio, bearishRatio, bullishCount, bearishCount, total } = calcBullishRatio(month);
    return {
      period: month.period ? month.period.substring(0, 7) : "unknown",
      strongBuy: month.strongBuy || 0,
      buy: month.buy || 0,
      hold: month.hold || 0,
      sell: month.sell || 0,
      strongSell: month.strongSell || 0,
      bullishCount,
      bearishCount,
      totalAnalysts: total,
      bullishRatio,
      bearishRatio,
    };
  });

  const ratios = monthlyTrend.map((m) => m.bullishRatio);
  const latestRatio = ratios[0];
  const oldestRatio = ratios[ratios.length - 1];

  const { velocityScore, rawDelta } = calcVelocityScore(latestRatio, oldestRatio);
  const { accelerationDelta, accelerationLabel } = calcAcceleration(ratios);
  const regime = classifyRegime(latestRatio, rawDelta, accelerationDelta);
  const oneShotVerdict = buildVerdict(ticker, regime, velocityScore, latestRatio);

  // Net revision ratio: (bullish - bearish) / total
  const latest = monthlyTrend[0];
  const netRevisionRatio = parseFloat(
    ((latest.bullishCount - latest.bearishCount) / Math.max(latest.totalAnalysts, 1)).toFixed(4)
  );

  return {
    velocityScore,
    velocityRegime: regime,
    acceleration: accelerationLabel,
    oneShotVerdict,
    latestBullishRatio: latestRatio,
    netRevisionRatio,
    monthlyTrend,
  };
}

module.exports = { computeVelocity, calcBullishRatio };