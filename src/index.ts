import express from "express";
import dotenv from "dotenv";
import { mnemonicToAccount } from "viem/accounts";
import {
  createPublicClient,
  http,
  parseUnits,
  parseEventLogs,
  stringToHex,
  verifyMessage,
  keccak256,
  type Hash,
} from "viem";
import { tempoModerato } from "viem/chains";

dotenv.config();

const TRANSFER_WITH_MEMO_ABI = [
  {
    name: "TransferWithMemo",
    type: "event",
    inputs: [
      { type: "address", name: "from", indexed: true },
      { type: "address", name: "to", indexed: true },
      { type: "uint256", name: "amount" },
      { type: "bytes32", name: "memo", indexed: true },
    ],
  },
] as const;

const PRICE_PER_CALL = parseUnits("0.1", 6); // $0.1 per completion request
const USDC_TOKEN = process.env.USDC_TOKEN as `0x${string}`;

const publicClient = createPublicClient({
  chain: tempoModerato,
  transport: http(),
});
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

// Chat completions: requires TransferWithMemo payment ($0.1) before processing
app.post("/v1/chat/completions", async (req, res) => {
  await handlePaidCompletions(req, res);
});

app.post("/chat/completions", async (req, res) => {
  await handlePaidCompletions(req, res);
});

async function verifyPayment(
  paymentTx: Hash,
  requestId: string,
): Promise<{ valid: true } | { valid: false; error: string }> {
  const apiWallet = process.env.PROVIDER_WALLET_ADDRESS;
  if (!apiWallet) {
    return { valid: false, error: "PROVIDER_WALLET_ADDRESS not configured" };
  }

  const receipt = await publicClient.getTransactionReceipt({ hash: paymentTx });
  if (!receipt) {
    return { valid: false, error: "Transaction not found" };
  }

  const logs = parseEventLogs({
    abi: TRANSFER_WITH_MEMO_ABI,
    logs: receipt.logs,
    eventName: "TransferWithMemo",
  });

  const expectedMemo = keccak256(stringToHex(`api:${requestId}`));
  const payment = logs.find(
    (log) =>
      log.args.to?.toLowerCase() === apiWallet.toLowerCase() &&
      log.args.amount >= PRICE_PER_CALL &&
      log.args.memo === expectedMemo &&
      log.address.toLowerCase() === USDC_TOKEN.toLowerCase(),
  );

  if (!payment) {
    return {
      valid: false,
      error:
        "Invalid payment: no TransferWithMemo to API wallet with sufficient amount and matching memo and USDC token",
    };
  }

  return { valid: true };
}

async function handlePaidCompletions(
  req: express.Request,
  res: express.Response,
) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { paymentTx, requestId, ...completionParams } = body;

  if (!paymentTx || !requestId) {
    res.status(400).json({
      error: {
        message: "Missing paymentTx or requestId",
        type: "validation_error",
      },
    });
    return;
  }

  const paymentCheck = await verifyPayment(
    paymentTx as Hash,
    String(requestId),
  );
  if (!paymentCheck.valid) {
    res.status(402).json({
      error: {
        message: paymentCheck.error,
        type: "payment_error",
      },
    });
    return;
  }

  // Proxy to OpenRouter with completion params
  req.body = completionParams;
  await proxyToOpenRouter(req, res, "/chat/completions");
}

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
