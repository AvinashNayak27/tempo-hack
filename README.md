# tee-proxy

OpenRouter API proxy with pay-per-call USDC payments on Tempo Moderato. Proxies model listings and chat completions to OpenRouter, requiring a verified `TransferWithMemo` payment ($0.1 USDC) before processing completions. Returns signed attestations for completions and credits.

**Deployed on Eigen Cloud TEE (Trusted Execution Environment)** – runs inside a hardware-backed enclave so clients can verify inference integrity, attest to the actual models used, and trust that responses come from the attested code and configuration.

### Live Deployment

- **Base URL:** [https://vai.buildweekends.com/gm](https://vai.buildweekends.com/gm)
- **Eigen Verifier:** [https://verify-sepolia.eigencloud.xyz/app/0x4Da7920D83cc20a0De6a46C746256e893b772b50](https://verify-sepolia.eigencloud.xyz/app/0x4Da7920D83cc20a0De6a46C746256e893b772b50)

## Environment Variables

Create a `.env` file with:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for proxying requests |
| `PROVIDER_WALLET_ADDRESS` | Yes | Wallet address that receives USDC payments |
| `USDC_TOKEN` | Yes | USDC token contract address on Tempo Moderato |
| `MNEMONIC` | Yes* | Mnemonic for signing attestations (gm, completions, credits). When deployed to Eigen Cloud, this is **automatically set by [EigenCompute KMS](https://docs.eigencloud.xyz/eigencompute/concepts/eigencompute-kms-overview)** — derived deterministically from the app ID. For local dev, set manually in `.env`. |
| `PORT` | No | Server port (default: 3000) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/details` | Provider wallet, price per call ($0.1), USDC address |
| `GET` | `/v1/models`, `/models` | List models (proxied to OpenRouter) |
| `POST` | `/v1/chat/completions`, `/chat/completions` | Chat completions (requires payment) |
| `GET` | `/gm` | Returns signed "gm" + timestamp (verifiable via `/verify`) |
| `POST` | `/verify` | Validate EIP-191 signed message |
| `GET` | `/credits` | OpenRouter credits with signed attestation |

### Chat Completions (paid)

Request body must include:

- `paymentTx` – Transaction hash of USDC `TransferWithMemo` to provider wallet
- `requestId` – Unique ID; memo must be `keccak256(api:{requestId})`
- Standard OpenRouter completion params (`model`, `messages`, etc.)

Payment must be ≥ 0.1 USDC to the provider wallet with the correct memo.

## Development

### Setup & Local Testing

```bash
npm install
# Create .env with the variables above
npm run dev
```

### Docker Testing

```bash
docker build -t tee-proxy .
docker run --rm --env-file .env -p 3000:3000 tee-proxy
```

## Prerequisites

- **[ecloud CLI](https://github.com/Layr-Labs/ecloud)** – Install with `npm install -g @layr-labs/ecloud-cli`
- **Docker** – To package and publish your application image
- **ETH** – To pay for deployment transactions

## Deployment

Deploy to Eigen Cloud’s TEE for hardware-verified execution using the [ecloud CLI](https://github.com/Layr-Labs/ecloud):

```bash
ecloud compute app deploy username/image-name
```

The CLI will automatically detect the `Dockerfile` and build your app before deploying to the Trusted Execution Environment. **`MNEMONIC` is injected by [EigenCompute KMS](https://docs.eigencloud.xyz/eigencompute/concepts/eigencompute-kms-overview)** — each app gets a deterministic mnemonic derived from its application ID, so you don't need to provide it when deploying.

