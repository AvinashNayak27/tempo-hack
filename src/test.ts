/**
 * Test: completions flow - pay $0.1, then call /v1/chat/completions
 * Uses Wallet 1 to create payment and verify attestation.
 * Also tests /credits endpoint with signed attestation.
 *
 * Run: npx ts-node src/test.ts (with server running on localhost:3000)
 *
 * Prerequisites:
 * - PROVIDER_WALLET_ADDRESS and OPENROUTER_API_KEY in server .env
 * - Wallet 1 has USDC on Tempo (0x20c0000000000000000000000000000000000001)
 */
import { createClient, http, walletActions, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { tempoActions } from "viem/tempo";
import { parseUnits, stringToHex, pad, keccak256 } from "viem";
import { verifyMessage } from "viem";
import dotenv from "dotenv";

dotenv.config();

const BASE_URL = "https://vai.buildweekends.com";

// Wallet 1 - test account
const WALLET_1 = {
  address: "0x031891A61200FedDd622EbACC10734BC90093B2A" as const,
  privateKey:
    "0x2b9e3b8a095940cf3461e27bfb2bebb498df9a6381b76b9f9c48c9bbdc3c8192" as const,
};

async function main() {
  // Get provider details from /details endpoint
  console.log("Fetching provider details...");
  const detailsRes = await fetch(`${BASE_URL}/details`);
  if (!detailsRes.ok) {
    console.error(
      "Failed to fetch details:",
      detailsRes.status,
      await detailsRes.text(),
    );
    process.exit(1);
  }

  const details = (await detailsRes.json()) as {
    providerWallet: string;
    pricePerCall: string;
    usdcAddress: string;
  };

  const providerWallet = details.providerWallet;
  const pricePerCall = BigInt(details.pricePerCall);
  const USDC_TOKEN = details.usdcAddress;

  console.log("Wallet 1:", WALLET_1.address);
  console.log("Provider wallet:", providerWallet);
  console.log("Price per call:", details.pricePerCall, "USDC\n");

  const account = privateKeyToAccount(WALLET_1.privateKey);
  const client = createClient({
    account,
    chain: tempoModerato,
    transport: http(),
  })
    .extend(publicActions)
    .extend(walletActions)
    .extend(tempoActions());

  const requestId = crypto.randomUUID();
  // Hash the memo string first to ensure it fits in 32 bytes
  const memo = keccak256(stringToHex(`api:${requestId}`));

  console.log("1. Sending payment (TransferWithMemo)...");
  const { receipt } = await client.token.transferSync({
    to: providerWallet as `0x${string}`,
    amount: pricePerCall,
    token: USDC_TOKEN as `0x${string}`,
    memo,
  });

  console.log("   Tx hash:", receipt.transactionHash);
  console.log("");

  console.log("2. Calling /v1/chat/completions...");
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paymentTx: receipt.transactionHash,
      requestId,
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: 'Hey gm how are you' }],
    }),
  });

  if (!res.ok) {
    console.error("Request failed:", res.status, await res.text());
    process.exit(1);
  }

  const data = (await res.json()) as {
    id?: string;
    model?: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    attestation?: { address: string; message: string; signature: string };
    choices?: Array<{ message?: { content?: string } }>;
  };

  console.log("Response received:");
  console.log("  id:", data.id);
  console.log("  model:", data.model);
  console.log("  usage:", JSON.stringify(data.usage));
  console.log("  content:", data.choices?.[0]?.message?.content ?? "(none)");
  console.log("");

  const { attestation } = data;
  if (!attestation) {
    console.error("No attestation (is MNEMONIC configured on server?)");
    process.exit(1);
  }

  console.log("3. Verifying attestation...");
  try {
    const valid = await verifyMessage({
      address: attestation.address as `0x${string}`,
      message: attestation.message,
      signature: attestation.signature as `0x${string}`,
    });
    if (valid) {
      console.log("   Verification: PASSED");
    } else {
      console.error("   Verification: FAILED");
      process.exit(1);
    }
  } catch (err) {
    console.error("   Verification error:", err);
    process.exit(1);
  }

  const parsed = JSON.parse(attestation.message) as {
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  console.log(
    "\nAttestation: model=%s, total_tokens=%d",
    parsed.model,
    parsed.usage.total_tokens,
  );

  // 4. Test /credits endpoint with signed attestation
  console.log("\n4. Calling /credits...");
  const creditsRes = await fetch(`${BASE_URL}/credits`);
  if (!creditsRes.ok) {
    console.error(
      "Credits request failed:",
      creditsRes.status,
      await creditsRes.text(),
    );
    process.exit(1);
  }

  const creditsData = (await creditsRes.json()) as {
    data?: { total_credits?: number; total_usage?: number };
    attestation?: { address: string; message: string; signature: string };
  };

  console.log("   total_credits:", creditsData.data?.total_credits);
  console.log("   total_usage:", creditsData.data?.total_usage);

  if (creditsData.attestation) {
    console.log("\n5. Verifying credits attestation...");
    const validCredits = await verifyMessage({
      address: creditsData.attestation.address as `0x${string}`,
      message: creditsData.attestation.message,
      signature: creditsData.attestation.signature as `0x${string}`,
    });
    if (validCredits) {
      console.log("   Credits attestation: PASSED");
      const creditsPayload = JSON.parse(creditsData.attestation.message) as {
        total_credits: number;
        total_usage: number;
        timestamp: number;
      };
      console.log(
        "   Signed payload: total_credits=%s, total_usage=%s",
        creditsPayload.total_credits,
        creditsPayload.total_usage,
      );
    } else {
      console.error("   Credits attestation: FAILED");
      process.exit(1);
    }
  } else {
    console.log(
      "\n5. No attestation on credits (MNEMONIC may not be configured)",
    );
  }

  console.log("\nAll checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
