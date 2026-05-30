// src/index.js — AnalystMomentum CTX Protocol MCP Server

require("dotenv").config();
const express = require("express");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { createContextMiddleware } = require("@ctxprotocol/sdk");
const { getAnalystMomentum } = require("./tools/analyst_momentum");

const app = express();
app.use(express.json());
app.use(createContextMiddleware());

// Shared _meta config (Query mode, free-tier pacing)
// surface "answer" = Query mode only. queryEligible true = appears in Context app.
// latencyClass "fast" = makes live API calls with caching, not a single instant lookup.
// pricing.queryUsd = listing response price. rateLimit = safe pacing for free-tier upstreams.
const TOOL_META = {
  surface: "answer",
  queryEligible: true,
  latencyClass: "fast",
  pricing: { queryUsd: "0.07" },
  rateLimit: { maxRequestsPerMinute: 60, cooldownMs: 1000, maxConcurrency: 5 }
};

//  Input Schemas

const TICKER_INPUT = {
  type: "object",
  properties: {
    ticker: { type: "string", description: "Stock ticker symbol e.g. PLTR, NVDA, TSLA", examples: ["PLTR","NVDA","TSLA","AAPL","GME"] }
  },
  required: ["ticker"]
};

const COMPARE_INPUT = {
  type: "object",
  properties: {
    ticker1: { type: "string", description: "First stock ticker e.g. PLTR", examples: ["PLTR","NVDA"] },
    ticker2: { type: "string", description: "Second stock ticker e.g. NVDA", examples: ["NVDA","AAPL"] },
    ticker3: { type: "string", description: "Optional third ticker for 3-way comparison e.g. AMD", examples: ["AMD","INTC"] }
  },
  required: ["ticker1","ticker2"]
};

const SCREEN_INPUT = {
  type: "object",
  properties: {
    tickers: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 5,
      description: "2-5 stock tickers to screen and rank by monthly sentiment regime e.g. [\"PLTR\",\"NVDA\",\"AMD\",\"TSLA\"]"
    }
  },
  required: ["tickers"]
};

// Output Schemas (narrowed per tool)

// Full schema — get_analyst_momentum
const FULL_OUTPUT = {
  type: "object",
  properties: {
    ticker:               { type: "string" },
    oneShotVerdict:       { type: "string" },
    velocityScore:        { type: "number" },
    velocityRegime:       { type: "string" },
    acceleration:         { type: "string" },
    currentConsensus: {
      type: "object",
      properties: {
        strongBuy:     { type: "number" },
        buy:           { type: "number" },
        hold:          { type: "number" },
        sell:          { type: "number" },
        strongSell:    { type: "number" },
        totalAnalysts: { type: "number" },
        bullishRatio:  { type: "number" },
        bearishRatio:  { type: "number" }
      }
    },
    analystTargetPrice:    { type: ["number","null"] },
    monthlyTrend: {
      type: "array",
      items: {
        type: "object",
        properties: {
          period:        { type: "string" },
          strongBuy:     { type: "number" },
          buy:           { type: "number" },
          hold:          { type: "number" },
          sell:          { type: "number" },
          strongSell:    { type: "number" },
          bullishCount:  { type: "number" },
          bearishCount:  { type: "number" },
          totalAnalysts: { type: "number" },
          bullishRatio:  { type: "number" },
          bearishRatio:  { type: "number" }
        }
      }
    },
    netRevisionRatio:      { type: "number" },
    priceTargetDelta:      { type: ["number","null"] },
    priceTargetDispersion: { type: ["number","null"] },
    percentileOfHistory:   { type: ["number","null"] },
    sourceRefs:            { type: "array", items: { type: "string" } },
    asOf:                  { type: "string" },
    confidence:            { type: "number" },
    freshnessNote:         { type: "string" }
  },
  required: ["ticker","oneShotVerdict","velocityScore","velocityRegime","currentConsensus","monthlyTrend","sourceRefs","asOf","confidence"]
};

// Consensus-focused — get_analyst_consensus
const CONSENSUS_OUTPUT = {
  type: "object",
  properties: {
    ticker:             { type: "string" },
    currentConsensus: {
      type: "object",
      properties: {
        strongBuy:     { type: "number" },
        buy:           { type: "number" },
        hold:          { type: "number" },
        sell:          { type: "number" },
        strongSell:    { type: "number" },
        totalAnalysts: { type: "number" },
        bullishRatio:  { type: "number" },
        bearishRatio:  { type: "number" }
      }
    },
    analystTargetPrice: { type: ["number","null"] },
    velocityRegime:     { type: "string" },
    sourceRefs:         { type: "array", items: { type: "string" } },
    asOf:               { type: "string" }
  },
  required: ["ticker","currentConsensus","velocityRegime","asOf"]
};

// Price target focused — get_analyst_price_target
const PRICE_TARGET_OUTPUT = {
  type: "object",
  properties: {
    ticker:                { type: "string" },
    analystTargetPrice:    { type: ["number","null"] },
    priceTargetDelta:      { type: ["number","null"] },
    priceTargetDispersion: { type: ["number","null"] },
    currentConsensus: {
      type: "object",
      properties: {
        bullishRatio:  { type: "number" },
        totalAnalysts: { type: "number" }
      }
    },
    velocityRegime:  { type: "string" },
    oneShotVerdict:  { type: "string" },
    sourceRefs:      { type: "array", items: { type: "string" } },
    asOf:            { type: "string" }
  },
  required: ["ticker","analystTargetPrice","priceTargetDelta","priceTargetDispersion","velocityRegime","oneShotVerdict","asOf"]
};

// Sentiment shift focused — get_sentiment_shift
const SENTIMENT_SHIFT_OUTPUT = {
  type: "object",
  properties: {
    ticker:        { type: "string" },
    monthlyTrend: {
      type: "array",
      items: {
        type: "object",
        properties: {
          period:        { type: "string" },
          bullishRatio:  { type: "number" },
          bullishCount:  { type: "number" },
          bearishCount:  { type: "number" },
          totalAnalysts: { type: "number" }
        }
      }
    },
    acceleration:   { type: "string" },
    velocityScore:  { type: "number" },
    velocityRegime: { type: "string" },
    oneShotVerdict: { type: "string" },
    sourceRefs:     { type: "array", items: { type: "string" } },
    asOf:           { type: "string" }
  },
  required: ["ticker","monthlyTrend","acceleration","velocityScore","velocityRegime","oneShotVerdict","asOf"]
};

// Conviction focused — get_analyst_conviction
const CONVICTION_OUTPUT = {
  type: "object",
  properties: {
    ticker: { type: "string" },
    currentConsensus: {
      type: "object",
      properties: {
        strongBuy:     { type: "number" },
        buy:           { type: "number" },
        totalAnalysts: { type: "number" },
        bullishRatio:  { type: "number" }
      }
    },
    velocityRegime:  { type: "string" },
    velocityScore:   { type: "number" },
    oneShotVerdict:  { type: "string" },
    sourceRefs:      { type: "array", items: { type: "string" } },
    asOf:            { type: "string" }
  },
  required: ["ticker","currentConsensus","velocityRegime","velocityScore","oneShotVerdict","asOf"]
};

// Bearish reversal focused — get_bearish_reversal_signal
const BEARISH_OUTPUT = {
  type: "object",
  properties: {
    ticker:         { type: "string" },
    velocityRegime: { type: "string" },
    velocityScore:  { type: "number" },
    monthlyTrend: {
      type: "array",
      items: {
        type: "object",
        properties: {
          period:        { type: "string" },
          bullishRatio:  { type: "number" },
          totalAnalysts: { type: "number" }
        }
      }
    },
    oneShotVerdict: { type: "string" },
    sourceRefs:     { type: "array", items: { type: "string" } },
    asOf:           { type: "string" }
  },
  required: ["ticker","velocityRegime","velocityScore","monthlyTrend","oneShotVerdict","asOf"]
};

// Compare — supports 2 or 3 tickers
const COMPARE_OUTPUT = {
  type: "object",
  properties: {
    ticker1:     { type: "string" },
    ticker2:     { type: "string" },
    ticker3:     { type: ["string","null"] },
    winner:      { type: "string" },
    verdict:     { type: "string" },
    ticker1Data: FULL_OUTPUT,
    ticker2Data: FULL_OUTPUT,
    ticker3Data: { type: ["object","null"] },
    asOf:        { type: "string" }
  },
  required: ["ticker1","ticker2","winner","verdict","asOf"]
};

// Screen — ranked leaderboard
const SCREEN_OUTPUT = {
  type: "object",
  properties: {
    ranked: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank:           { type: "number" },
          ticker:         { type: "string" },
          velocityScore:  { type: "number" },
          velocityRegime: { type: "string" },
          oneShotVerdict: { type: "string" },
          bullishRatio:   { type: "number" }
        }
      }
    },
    asOf: { type: "string" }
  },
  required: ["ranked","asOf"]
};

// Tool Definitions

const TOOLS = [
  {
    name: "get_analyst_momentum",
    description: "Returns full sell-side analyst sentiment regime intelligence for any US-listed stock. Tracks how fast monthly consensus is shifting across 4-5 months of data. Regime: Stale, Awakening, Accelerating, Peak, or Decelerating. Includes price target dispersion, upside delta, and percentile of available history. Replaces Capital IQ and TipRanks at $0.07 per query.",
    _meta: TOOL_META,
    inputSchema: TICKER_INPUT, outputSchema: FULL_OUTPUT
  },
  {
    name: "get_analyst_consensus",
    description: "Returns current sell-side analyst consensus breakdown. Shows strong buy, buy, hold, sell, strong sell counts, bullish ratio, and price target. Answers: What percentage of analysts are bullish on this stock right now?",
    _meta: TOOL_META,
    inputSchema: TICKER_INPUT, outputSchema: CONSENSUS_OUTPUT
  },
  {
    name: "get_analyst_price_target",
    description: "Returns consensus analyst price target, upside delta from current price, and dispersion between high and low targets. Answers: What price are analysts targeting and how much do analysts disagree on this stock?",
    _meta: TOOL_META,
    inputSchema: TICKER_INPUT, outputSchema: PRICE_TARGET_OUTPUT
  },
  {
    name: "get_sentiment_shift",
    description: "Returns how much sell-side monthly consensus has shifted over the last 4-5 months. Tracks bullish ratio change month by month. Answers: How dramatically has analyst opinion changed and is the shift accelerating or decelerating?",
    _meta: TOOL_META,
    inputSchema: TICKER_INPUT, outputSchema: SENTIMENT_SHIFT_OUTPUT
  },
  {
    name: "compare_analyst_momentum",
    description: "Compares sell-side analyst sentiment regime between two or three stocks. Supports 2-way and 3-way comparison. Answers: Which stock has the strongest bullish monthly sentiment shift right now?",
    _meta: TOOL_META,
    inputSchema: COMPARE_INPUT, outputSchema: COMPARE_OUTPUT
  },
  {
    name: "get_analyst_conviction",
    description: "Returns analyst conviction strength by comparing Strong Buy vs Buy ratio. Answers: Are analysts mildly bullish or strongly convicted on this stock — is the bullish stance deep or shallow?",
    _meta: TOOL_META,
    inputSchema: TICKER_INPUT, outputSchema: CONVICTION_OUTPUT
  },
  {
    name: "get_bearish_reversal_signal",
    description: "Detects whether sell-side monthly consensus is beginning to turn bearish. Tracks month-over-month ratio delta and regime classification. Answers: Is bullish momentum reversing? Is the monthly consensus beginning to fall?",
    _meta: TOOL_META,
    inputSchema: TICKER_INPUT, outputSchema: BEARISH_OUTPUT
  },
  {
    name: "screen_analyst_momentum",
    description: "Screens and ranks 2-5 stocks by sell-side monthly sentiment regime score. Returns a ranked leaderboard with velocity scores and regimes. Answers: Which stock in my watchlist has the strongest analyst sentiment shift right now?",
    _meta: TOOL_META,
    inputSchema: SCREEN_INPUT, outputSchema: SCREEN_OUTPUT
  }
];

//  Server

app.post("/mcp", async (req, res) => {
  const server = new Server(
    { name: "analyst-momentum", version: "1.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ticker  = (args?.ticker  || "PLTR").toUpperCase().trim();
    const ticker1 = (args?.ticker1 || "PLTR").toUpperCase().trim();
    const ticker2 = (args?.ticker2 || "NVDA").toUpperCase().trim();
    const ticker3 = args?.ticker3 ? args.ticker3.toUpperCase().trim() : null;

    try {

      //  screen_analyst_momentum 
      if (name === "screen_analyst_momentum") {
        const tickers = (args?.tickers || []).map(t => t.toUpperCase().trim()).slice(0, 5);
        if (tickers.length < 2) throw new Error("Provide at least 2 tickers to screen");

        const results = await Promise.allSettled(tickers.map(t => getAnalystMomentum(t)));
        const ranked = results
          .map((r) => r.status === "fulfilled" ? r.value : null)
          .filter(Boolean)
          .sort((a, b) => b.velocityScore - a.velocityScore)
          .map((d, i) => ({
            rank:           i + 1,
            ticker:         d.ticker,
            velocityScore:  d.velocityScore,
            velocityRegime: d.velocityRegime,
            oneShotVerdict: d.oneShotVerdict,
            bullishRatio:   d.currentConsensus.bullishRatio,
          }));

        const screenData = { ranked, asOf: new Date().toISOString().substring(0, 10) };
        const text = ranked.map(r =>
          `#${r.rank} ${r.ticker}: ${r.velocityScore}/100 — ${r.velocityRegime} — ${Math.round(r.bullishRatio * 100)}% bullish`
        ).join("\n");

        return {
          content: [{ type: "text", text: `Analyst Momentum Ranking:\n${text}` }],
          structuredContent: screenData,
          _meta: {}
        };
      }

      //  compare_analyst_momentum (2-way or 3-way) 
      if (name === "compare_analyst_momentum") {
        const fetches = [getAnalystMomentum(ticker1), getAnalystMomentum(ticker2)];
        if (ticker3) fetches.push(getAnalystMomentum(ticker3));
        const [r1, r2, r3] = await Promise.all(fetches);

        const candidates = [r1, r2, r3].filter(Boolean);
        const winner = candidates.reduce((best, cur) =>
          cur.velocityScore > best.velocityScore ? cur : best
        ).ticker;

        const verdictLines = candidates.map(r =>
          `${r.ticker}: ${r.velocityScore}/100 — ${r.velocityRegime} — ${Math.round(r.currentConsensus.bullishRatio * 100)}% bullish`
        );
        verdictLines.push(`Winner: ${winner} has the strongest sell-side momentum.`);

        const compData = {
          ticker1: r1.ticker,
          ticker2: r2.ticker,
          ticker3: r3 ? r3.ticker : null,
          winner,
          verdict: verdictLines.join("\n"),
          ticker1Data: r1,
          ticker2Data: r2,
          ticker3Data: r3 || null,
          asOf: new Date().toISOString().substring(0, 10),
        };

        return {
          content: [{ type: "text", text: compData.verdict }],
          structuredContent: compData,
          _meta: {}
        };
      }

      // All single-ticker tools 
      const data = await getAnalystMomentum(ticker);
      const c = data.currentConsensus;
      let text;

      if (name === "get_analyst_consensus") {
        text = `Analyst Consensus — ${data.ticker}\nTotal: ${c.totalAnalysts} analysts\nStrong Buy: ${c.strongBuy} | Buy: ${c.buy} | Hold: ${c.hold} | Sell: ${c.sell} | Strong Sell: ${c.strongSell}\nBullish: ${Math.round(c.bullishRatio * 100)}% | Bearish: ${Math.round(c.bearishRatio * 100)}%\nPrice Target: ${data.analystTargetPrice ? "$" + data.analystTargetPrice : "N/A"}\nRegime: ${data.velocityRegime} | as of: ${data.asOf}`;

      } else if (name === "get_analyst_price_target") {
        const delta = data.priceTargetDelta != null
          ? `${data.priceTargetDelta > 0 ? "+" : ""}${Math.round(data.priceTargetDelta * 100)}% upside` : "N/A";
        const dispersion = data.priceTargetDispersion != null
          ? `${Math.round(data.priceTargetDispersion * 100)}% spread between high and low targets` : "N/A";
        text = `Price Target — ${data.ticker}\nTarget: ${data.analystTargetPrice ? "$" + data.analystTargetPrice : "N/A"}\nUpside Delta: ${delta}\nDispersion: ${dispersion}\nBullish: ${Math.round(c.bullishRatio * 100)}% of ${c.totalAnalysts} analysts\n${data.oneShotVerdict}`;

      } else if (name === "get_sentiment_shift") {
        const trend = data.monthlyTrend;
        const oldest = trend[trend.length - 1];
        const latest = trend[0];
        const shiftPct = Math.round((latest.bullishRatio - oldest.bullishRatio) * 100);
        text = `Sentiment Shift — ${data.ticker}\n${oldest.period}: ${Math.round(oldest.bullishRatio * 100)}% bullish\n${latest.period}: ${Math.round(latest.bullishRatio * 100)}% bullish\nTotal Shift: ${shiftPct > 0 ? "+" : ""}${shiftPct}% over ${trend.length} months\nAcceleration: ${data.acceleration}\n${data.oneShotVerdict}`;

      } else if (name === "get_analyst_conviction") {
        const totalBullish = c.strongBuy + c.buy;
        const convRatio = totalBullish > 0 ? c.strongBuy / totalBullish : 0;
        const level = convRatio >= 0.5 ? "High Conviction"
          : convRatio >= 0.3 ? "Moderate Conviction"
          : convRatio >= 0.1 ? "Low Conviction"
          : "Minimal Conviction";
        text = `Analyst Conviction — ${data.ticker}\n${level}\nStrong Buy: ${c.strongBuy} | Buy: ${c.buy} | Strong Buy Ratio: ${Math.round(convRatio * 100)}%\n${data.oneShotVerdict}`;

      } else if (name === "get_bearish_reversal_signal") {
        const trend = data.monthlyTrend;
        const ratioDelta = parseFloat((trend[0].bullishRatio - (trend[1] || trend[0]).bullishRatio).toFixed(4));
        const signal = data.velocityRegime === "Decelerating" ? "BEARISH REVERSAL DETECTED"
          : ratioDelta < -0.02 ? "EARLY BEARISH SIGNAL"
          : data.velocityRegime === "Peak" ? "PEAK CAUTION"
          : "NO BEARISH REVERSAL";
        text = `Bearish Reversal — ${data.ticker}\nSignal: ${signal}\nMoM Delta: ${ratioDelta > 0 ? "+" : ""}${Math.round(ratioDelta * 100)}%\n${data.oneShotVerdict}`;

      } else {
        // get_analyst_momentum — full text summary
        text = `Analyst Momentum — ${data.ticker}\n${data.oneShotVerdict}\nVelocity: ${data.velocityScore}/100 | Regime: ${data.velocityRegime}\nAcceleration: ${data.acceleration}\nBullish: ${Math.round(c.bullishRatio * 100)}% of ${c.totalAnalysts} analysts\nPrice Target: ${data.analystTargetPrice ? "$" + data.analystTargetPrice : "N/A"}\nas of: ${data.asOf} | Confidence: ${data.confidence}`;
      }

      return {
        content: [{ type: "text", text }],
        structuredContent: data,
        _meta: {}
      };

    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (req, res) => res.json({ status: "ok", tool: "analyst-momentum", version: "1.2.0" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AnalystMomentum MCP Server running on port ${PORT}`);
  console.log(`MCP: http://localhost:${PORT}/mcp`);
});

module.exports = app;