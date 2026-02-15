import express from "express";
import dotenv from "dotenv";
import { parseUnits } from "viem";

dotenv.config();

const PRICE_PER_CALL = parseUnits("0.1", 6); // $0.1 per completion request
const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/details", async (_req, res) => {
  const providerWallet = process.env.PROVIDER_WALLET_ADDRESS;
  const usdcAddress = process.env.USDC_TOKEN;
  if (!providerWallet || !usdcAddress) {
    res.status(500).json({
      error: {
        message: "PROVIDER_WALLET_ADDRESS or USDC_TOKEN not configured",
        type: "config_error",
      },
    });
    return;
  }

  res.json({
    providerWallet,
    pricePerCall: PRICE_PER_CALL.toString(),
    usdcAddress,
  });
});

app.listen(PORT, () => {
  console.log(`OpenRouter proxy listening on http://localhost:${PORT}`);
});
