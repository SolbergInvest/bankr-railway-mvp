import express from "express";
import cors from "cors";
import { BankrClient } from "@bankr/sdk";
import { maxUint256 } from "viem";

const {
  PORT = 3000,
  BANKR_API_KEY,
  BANKR_PRIVATE_KEY,
  BANKR_BASE_URL,     // optional
  BANKR_PROXY_TOKEN,  // optional shared secret
  CORS_ORIGIN         // optional CSV of allowed origins
} = process.env;

if (!BANKR_API_KEY || !BANKR_PRIVATE_KEY) {
  throw new Error("Missing BANKR_API_KEY or BANKR_PRIVATE_KEY");
}

const client = new BankrClient({
  apiKey: BANKR_API_KEY,
  privateKey: BANKR_PRIVATE_KEY,
  ...(BANKR_BASE_URL ? { baseUrl: BANKR_BASE_URL } : {})
});

const app = express();
app.use(express.json());
app.use(cors({
  origin: CORS_ORIGIN ? CORS_ORIGIN.split(",") : true
}));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// One-time BNKR allowance to the facilitator (for x402 per-request payments)
app.post("/api/bankr/approve-bnkr", async (req, res) => {
  try {
    if (BANKR_PROXY_TOKEN && req.get("x-proxy-token") !== BANKR_PROXY_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const spender = "0x4a15fc613c713FC52E907a77071Ec2d0a392a584";
    const txHash = await client.approve(spender, maxUint256);
    const allowance = await client.checkAllowance(spender);
    res.json({ txHash, allowance: allowance.toString(), wallet: client.getWalletAddress() });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? "unknown error" });
  }
});

// Main endpoint: call Bankr and wait for completion
app.post("/api/bankr/promptAndWait", async (req, res) => {
  try {
    if (BANKR_PROXY_TOKEN && req.get("x-proxy-token") !== BANKR_PROXY_TOKEN) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { prompt, walletAddress, xmtp } = req.body ?? {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }
    const result = await client.promptAndWait({
      prompt,
      walletAddress,
      xmtp,
      interval: 2000,
      maxAttempts: 150,
      timeout: 300000
    });
    res.json({
      jobId: result.jobId,
      status: result.status,
      response: result.response ?? null,
      transactions: result.transactions ?? [],
      richData: result.richData ?? []
    });
  } catch (e) {
    res.status(500).json({ error: e?.message ?? "unknown error" });
  }
});

app.listen(PORT, () => console.log(`Bankr proxy on :${PORT}`));
