import express from "express";
import dotenv from "dotenv";
import { mnemonicToAccount } from "viem/accounts";
import { parseUnits, verifyMessage } from "viem";

dotenv.config();

const PRICE_PER_CALL = parseUnits("0.1", 6); // $0.1 per completion request
const app = express();
const PORT = process.env.PORT ?? 3000;
const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

app.use(express.json({ limit: "10mb" }));

// Proxy /v1/models to OpenRouter
app.get("/v1/models", async (req, res) => {
  await proxyToOpenRouter(req, res, "/models");
});

app.get("/models", async (req, res) => {
  await proxyToOpenRouter(req, res, "/models");
});

async function proxyToOpenRouter(
  req: express.Request,
  res: express.Response,
  path: string,
) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    res.status(500).json({
      error: {
        message: "OPENROUTER_API_KEY not configured",
        type: "proxy_error",
      },
    });
    return;
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const body =
      req.method !== "GET" ? JSON.stringify(req.body || {}) : undefined;
    const url = `${OPENROUTER_API_URL}${path}`;

    const openRouterRes = await fetch(url, {
      method: req.method,
      headers,
      body,
    });

    const contentType =
      openRouterRes.headers.get("content-type") ?? "application/json";

    if (contentType.includes("text/event-stream")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      const reader = openRouterRes.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value));
        }
      }
      res.end();
    } else {
      const data = (await openRouterRes.json()) as Record<string, unknown>;
      res.status(openRouterRes.status).json(data);
    }
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(502).json({
      error: {
        message:
          error instanceof Error ? error.message : "Proxy request failed",
        type: "proxy_error",
      },
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// GET /gm - returns address, signed "gm" + timestamp (verifiable via verifyMessage)
app.get("/gm", async (_req, res) => {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    res.status(500).json({
      error: { message: "MNEMONIC not configured", type: "config_error" },
    });
    return;
  }

  try {
    const account = mnemonicToAccount(mnemonic);
    const timestamp = Math.floor(Date.now() / 1000);
    const msg = `gm ${timestamp}`;
    const signature = await account.signMessage({ message: msg });

    res.json({ address: account.address, msg, signature });
  } catch (error) {
    console.error("GM sign error:", error);
    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : "Sign failed",
        type: "sign_error",
      },
    });
  }
});

// POST /verify - validate attestation or any EIP-191 signed message
app.post("/verify", async (req, res) => {
  const { address, message, signature } = req.body ?? {};

  if (!address || !message || !signature) {
    res.status(400).json({
      error: {
        message: "Missing address, message, or signature",
        type: "validation_error",
      },
    });
    return;
  }

  try {
    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    res.json({ valid });
  } catch (error) {
    res.status(400).json({
      valid: false,
      error: {
        message: error instanceof Error ? error.message : "Verification failed",
      },
    });
  }
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
