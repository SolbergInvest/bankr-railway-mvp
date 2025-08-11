import express from "express";
import cors from "cors";
import { BankrClient } from "@bankr/sdk";

const {
  PORT = 3000,
  BANKR_API_KEY,
  BANKR_PRIVATE_KEY,
  BANKR_BASE_URL,         // optional, defaults to https://api-staging.bankr.bot
  BANKR_PROXY_TOKEN,      // optional shared secret for your frontend
  CORS_ORIGIN             // optional, e.g. "https://your.site,https://staging.site"
} = process.env;

if (!BANKR_API_KEY || !BANKR_PRIVATE_KEY) {
  throw new Error("BANKR_API_KEY and BANKR_PRIVATE_KEY are required");
}

const client = new BankrClient({
  apiKey: BANKR_API_KEY,
  privateKey: BANKR_PRIVATE_KEY,
  ...(BANKR_BASE_URL ? { baseUrl: BANKR_BASE_URL } : {})
});

const app = express();
app.use(express.json());
app.use(cors({
  origin: CORS_ORIGIN ? CORS_ORIGIN.split(",") : true,
  credentials: false
}));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/api/bankr/prompt", async (req, res) => {
  try {
    if (BANKR_PROXY_TOKEN && req.get("x-proxy-token") !== BANKR_PROXY_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { prompt, walletAddress, xmtp, poll } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }
    const result = await client.promptAndWait({
      prompt,
      walletAddress,
      xmtp,
      interval: poll?.interval ?? 2000,
      maxAttempts: poll?.maxAttempts ?? 150,
      timeout: poll?.timeout ?? 300_000
    });
    res.json({
      jobId: result.jobId,
      status: result.status,
      response: result.response ?? null,
      transactions: result.transactions ?? [],
      richData: result.richData ?? []
    });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? "unknown error" });
  }
});

// (Optional) manual BNKR approval helper if your first call returns a 402 with a facilitator address
app.post("/api/bankr/approve", async (req, res) => {
  try {
    if (BANKR_PROXY_TOKEN && req.get("x-proxy-token") !== BANKR_PROXY_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { spender, amount } = req.body ?? {};
    if (!spender) return res.status(400).json({ error: "spender is required" });
    const txHash = await client.approve(spender, amount ? BigInt(amount) : undefined);
    res.json({ txHash, wallet: client.getWalletAddress() });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? "unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`Bankr proxy listening on :${PORT}`);
});
