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

//  NEW: Event-based velocity functions

/**
 * Get the most active analyst firm from a list of events
 */
function getLeadingFirm(events) {
  if (!events || events.length === 0) return null;
  const firmCounts = {};
  for (const e of events) {
    if (e.firm) firmCounts[e.firm] = (firmCounts[e.firm] || 0) + 1;
  }
  return Object.keys(firmCounts).sort((a, b) => firmCounts[b] - firmCounts[a])[0] || null;
}

/**
 * Compute event-based velocity score from individual upgrade/downgrade events
 * Uses 60-day rolling window from Yahoo Finance upgradeDowngradeHistory
 * Score: net upgrades scaled to 0-100. 0 net events = 0 (truly stale), +5 net = ~100
 */
function computeVelocityFromEvents(events) {
  if (!events || events.length === 0) {
    return {
      eventVelocityScore: null,
      upgrades60d: [],
      leadingFirm: null,
      upgrades60dCount: 0,
      downgrades60dCount: 0,
      netEvents60d: 0,
    };
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const days60Secs = 60 * 24 * 3600;

  // Filter to last 60 days, only real upgrades and downgrades
  const events60d = events.filter(
    (e) => (nowEpoch - e.epochGradeDate) <= days60Secs && ["up", "down"].includes(e.action)
  );

  let upgrades60 = 0;
  let downgrades60 = 0;

  for (const e of events60d) {
    if (e.action === "up") upgrades60++;
    else if (e.action === "down") downgrades60++;
  }

  const netEvents60 = upgrades60 - downgrades60;
  const totalEvents60 = upgrades60 + downgrades60;

  // Score: 50 = neutral, each net upgrade adds 10 points, capped 0-100
  // If no events at all in 60 days → 0 (truly stale, not just neutral)
  let eventVelocityScore = null;
  if (totalEvents60 > 0) {
    eventVelocityScore = Math.min(100, Math.max(0, Math.round(50 + netEvents60 * 10)));
  }

  // Format events for output
  const upgrades60dFormatted = events60d.map((e) => ({
    date:      new Date(e.epochGradeDate * 1000).toISOString().substring(0, 10),
    firm:      e.firm      || "Unknown",
    fromGrade: e.fromGrade || null,
    toGrade:   e.toGrade   || null,
    action:    e.action,
  }));

  return {
    eventVelocityScore,
    upgrades60d:        upgrades60dFormatted,
    leadingFirm:        getLeadingFirm(events60d),
    upgrades60dCount:   upgrades60,
    downgrades60dCount: downgrades60,
    netEvents60d:       netEvents60,
  };
}

/**
 * Blend monthly velocity score with event-based velocity score
 * If events exist: 60% event score + 40% monthly score
 * If no events: monthly score only
 */
function blendVelocityScores(monthlyScore, eventScore) {
  if (eventScore === null) return monthlyScore;
  return Math.round(eventScore * 0.6 + monthlyScore * 0.4);
}

/**
 * Compute percentile of current bullishRatio within available monthly history
 * Based on available data window (4-5 months Finnhub) — not a 3-year window
 */
function computePercentileOfHistory(currentRatio, monthlyTrend) {
  if (!monthlyTrend || monthlyTrend.length < 2) return null;
  const allRatios = monthlyTrend.map((m) => m.bullishRatio);
  const below = allRatios.filter((r) => r <= currentRatio).length;
  return parseFloat((below / allRatios.length).toFixed(2));
}

/**
 * Compute price target delta and dispersion from Yahoo Finance price target data
 * priceTargetDelta: % upside from current price to mean analyst target
 * priceTargetDispersion: (high - low) / mean — measures analyst disagreement
 */
function computePriceTargetMetrics(ptData) {
  if (!ptData) return { priceTargetDelta: null, priceTargetDispersion: null };

  const priceTargetDelta =
    ptData.targetMeanPrice && ptData.currentPrice
      ? parseFloat(((ptData.targetMeanPrice - ptData.currentPrice) / ptData.currentPrice).toFixed(4))
      : null;

  const priceTargetDispersion =
    ptData.targetHighPrice && ptData.targetLowPrice && ptData.targetMeanPrice
      ? parseFloat(((ptData.targetHighPrice - ptData.targetLowPrice) / ptData.targetMeanPrice).toFixed(4))
      : null;

  return { priceTargetDelta, priceTargetDispersion };
}

module.exports = {
  computeVelocity,
  calcBullishRatio,
  computeVelocityFromEvents,
  blendVelocityScores,
  computePercentileOfHistory,
  computePriceTargetMetrics,
};