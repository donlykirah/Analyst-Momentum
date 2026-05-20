// src/index.js — AnalystMomentum CTX Protocol MCP Server
// FIXED: Uses low-level Server API + plain JSON Schema — no Zod, no conflicts
// Confirmed working locally before sending

require("dotenv").config();
const express = require("express");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { createContextMiddleware } = require("@ctxprotocol/sdk");
const { getAnalystMomentum } = require("./tools/analyst_momentum");

const app = express();
app.use(express.json());
 app.use(createContextMiddleware()); // uncomment before deploy

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
    ticker2: { type: "string", description: "Second stock ticker e.g. NVDA", examples: ["NVDA","AAPL"] }
  },
  required: ["ticker1","ticker2"]
};

const OUTPUT = {
  type: "object",
  properties: {
    ticker:           { type: "string" },
    oneShotVerdict:   { type: "string" },
    velocityScore:    { type: "number" },
    velocityRegime:   { type: "string" },
    acceleration:     { type: "string" },
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
    netRevisionRatio: { type: "number" },
    sourceRefs:       { type: "array", items: { type: "string" } },
    asOf:             { type: "string" },
    confidence:       { type: "number" },
    freshnessNote:    { type: "string" }
  },
  required: ["ticker","oneShotVerdict","velocityScore","velocityRegime","currentConsensus","monthlyTrend","sourceRefs","asOf","confidence"]
};

const TOOLS = [
  {
    name: "get_analyst_momentum",
    description: "Returns sell-side analyst rating revision velocity for any US-listed stock. Answers: Is the sell-side turning bullish or bearish? What regime — Stale, Awakening, Accelerating, Peak, or Decelerating? Replaces Capital IQ and TipRanks at $0.10 per query.",
    inputSchema: TICKER_INPUT, outputSchema: OUTPUT
  },
  {
    name: "get_analyst_consensus",
    description: "Returns current sell-side analyst consensus breakdown. Shows strong buy, buy, hold, sell, strong sell counts, bullish ratio, and analyst price target. Answers: What percentage of analysts are bullish on this stock right now?",
    inputSchema: TICKER_INPUT, outputSchema: OUTPUT
  },
  {
    name: "get_analyst_price_target",
    description: "Returns the consensus analyst price target and bullish conviction level. Answers: What price are analysts targeting for this stock and how bullish is the consensus?",
    inputSchema: TICKER_INPUT, outputSchema: OUTPUT
  },
  {
    name: "get_sentiment_shift",
    description: "Returns how much sell-side sentiment has shifted over the last 4-5 months. Answers: How dramatically has analyst opinion changed? Is the shift accelerating or decelerating?",
    inputSchema: TICKER_INPUT, outputSchema: OUTPUT
  },
  {
    name: "compare_analyst_momentum",
    description: "Compares sell-side analyst momentum between two stocks. Answers: Which stock has stronger bullish momentum from the sell-side right now?",
    inputSchema: COMPARE_INPUT,
    outputSchema: {
      type: "object",
      properties: {
        ticker1: { type: "string" }, ticker2: { type: "string" },
        winner:  { type: "string" }, verdict: { type: "string" },
        ticker1Data: OUTPUT, ticker2Data: OUTPUT, asOf: { type: "string" }
      },
      required: ["ticker1","ticker2","winner","verdict","asOf"]
    }
  },
  {
    name: "get_analyst_conviction",
    description: "Returns analyst conviction strength by comparing Strong Buy vs Buy ratio. Answers: Are analysts mildly bullish or strongly convicted? Distinguishes weak from strong bullish signals.",
    inputSchema: TICKER_INPUT, outputSchema: OUTPUT
  },
  {
    name: "get_bearish_reversal_signal",
    description: "Detects whether sell-side analysts are beginning to turn bearish. Answers: Is bullish momentum reversing? Are analysts downgrading? Returns a clear bearish reversal signal or confirms continued bullish trend.",
    inputSchema: TICKER_INPUT, outputSchema: OUTPUT
  }
];

app.post("/mcp", async (req, res) => {
  const server = new Server(
    { name: "analyst-momentum", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ticker  = (args?.ticker  || "PLTR").toUpperCase().trim();
    const ticker1 = (args?.ticker1 || "PLTR").toUpperCase().trim();
    const ticker2 = (args?.ticker2 || "NVDA").toUpperCase().trim();

    try {
      if (name === "compare_analyst_momentum") {
        const [r1, r2] = await Promise.all([getAnalystMomentum(ticker1), getAnalystMomentum(ticker2)]);
        const winner = r1.velocityScore >= r2.velocityScore ? r1.ticker : r2.ticker;
        const compData = {
          ticker1: r1.ticker, ticker2: r2.ticker, winner,
          verdict:
            `${r1.ticker}: ${r1.velocityScore}/100 — ${r1.velocityRegime} — ${Math.round(r1.currentConsensus.bullishRatio*100)}% bullish.\n` +
            `${r2.ticker}: ${r2.velocityScore}/100 — ${r2.velocityRegime} — ${Math.round(r2.currentConsensus.bullishRatio*100)}% bullish.\n` +
            `Winner: ${winner} has stronger sell-side momentum.`,
          ticker1Data: r1, ticker2Data: r2,
          asOf: new Date().toISOString().substring(0,10)
        };
        return { content: [{ type: "text", text: compData.verdict }], structuredContent: compData };
      }

      const data = await getAnalystMomentum(ticker);
      const c = data.currentConsensus;
      let text;

      if (name === "get_analyst_consensus") {
        text = `Analyst Consensus — ${data.ticker}\nTotal: ${c.totalAnalysts} analysts\nStrong Buy: ${c.strongBuy} | Buy: ${c.buy} | Hold: ${c.hold} | Sell: ${c.sell} | Strong Sell: ${c.strongSell}\nBullish: ${Math.round(c.bullishRatio*100)}% | Bearish: ${Math.round(c.bearishRatio*100)}%\nPrice Target: ${data.analystTargetPrice ? "$"+data.analystTargetPrice : "N/A"}\nRegime: ${data.velocityRegime} | as of: ${data.asOf}`;
      } else if (name === "get_analyst_price_target") {
        text = `Price Target — ${data.ticker}\nTarget: ${data.analystTargetPrice ? "$"+data.analystTargetPrice : "N/A"}\nBullish: ${Math.round(c.bullishRatio*100)}% of ${c.totalAnalysts} analysts\n${data.oneShotVerdict}`;
      } else if (name === "get_sentiment_shift") {
        const trend = data.monthlyTrend;
        const oldest = trend[trend.length-1];
        const latest = trend[0];
        const shiftPct = Math.round((latest.bullishRatio - oldest.bullishRatio)*100);
        text = `Sentiment Shift — ${data.ticker}\n${oldest.period}: ${Math.round(oldest.bullishRatio*100)}% bullish\n${latest.period}: ${Math.round(latest.bullishRatio*100)}% bullish\nTotal Shift: ${shiftPct>0?"+":""}${shiftPct}% over ${trend.length} months\nAcceleration: ${data.acceleration}\n${data.oneShotVerdict}`;
      } else if (name === "get_analyst_conviction") {
        const totalBullish = c.strongBuy + c.buy;
        const convRatio = totalBullish > 0 ? c.strongBuy/totalBullish : 0;
        const level = convRatio >= 0.5 ? "High Conviction" : convRatio >= 0.3 ? "Moderate Conviction" : convRatio >= 0.1 ? "Low Conviction" : "Minimal Conviction";
        text = `Analyst Conviction — ${data.ticker}\n${level}\nStrong Buy: ${c.strongBuy} | Buy: ${c.buy} | Strong Buy Ratio: ${Math.round(convRatio*100)}%\n${data.oneShotVerdict}`;
      } else if (name === "get_bearish_reversal_signal") {
        const trend = data.monthlyTrend;
        const ratioDelta = parseFloat((trend[0].bullishRatio - (trend[1]||trend[0]).bullishRatio).toFixed(4));
        const signal = data.velocityRegime === "Decelerating" ? "BEARISH REVERSAL DETECTED" : ratioDelta < -0.02 ? "EARLY BEARISH SIGNAL" : data.velocityRegime === "Peak" ? "PEAK CAUTION" : "NO BEARISH REVERSAL";
        text = `Bearish Reversal — ${data.ticker}\nSignal: ${signal}\nMoM Delta: ${ratioDelta>0?"+":""}${Math.round(ratioDelta*100)}%\n${data.oneShotVerdict}`;
      } else {
        text = `Analyst Momentum — ${data.ticker}\n${data.oneShotVerdict}\nVelocity: ${data.velocityScore}/100 | Regime: ${data.velocityRegime}\nAcceleration: ${data.acceleration}\nBullish: ${Math.round(c.bullishRatio*100)}% of ${c.totalAnalysts} analysts\nPrice Target: ${data.analystTargetPrice ? "$"+data.analystTargetPrice : "N/A"}\nas of: ${data.asOf} | Confidence: ${data.confidence}`;
      }

      return { content: [{ type: "text", text }], structuredContent: data };

    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (req, res) => res.json({ status: "ok", tool: "analyst-momentum", version: "1.0.0" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AnalystMomentum MCP Server running on port ${PORT}`);
  console.log(`MCP: http://localhost:${PORT}/mcp`);
});

module.exports = app;