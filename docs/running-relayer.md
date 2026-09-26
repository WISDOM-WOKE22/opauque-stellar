# Running The Relayer

The relayer market lets users withdraw from the privacy pool without submitting the withdrawal from their connected wallet. A relayer bids on a job, receives an encrypted payload, submits the Soroban transaction, and earns the escrowed fee.

For the MVP demo, a relayer is already running on testnet at `https://g-stelar-relayer.opaque.cash`. Operators can run additional relayers and connect them to the shared gateway.

> Prefer a container? See [Running the services with Docker](running-with-docker.md), which builds a pinned, non-root image for the relayer (and the ASP + publisher) and brings them all up with `docker compose up`.

## Production Shape

The intended production shape is a shared public gossip hub:

```text
wallet -> public gateway hub -> relayer nodes
```

Wallets publish and subscribe through a gateway URL from the deployment manifest or frontend environment. Relayer nodes connect to the hub and bid on jobs. This means users do not have to paste a manual relayer URL.

The testnet manifest currently points wallets at the MVP demo gateway:

```text
https://g-stelar-relayer.opaque.cash
```

The gateway topic is:

```text
opaque/stellar/jobs/v1
```

The current implementation exposes this over the relayer HTTP gateway. The gossip transport is structured so a libp2p or pubsub backend can replace the in-memory transport later.

## Flow

1. Operator registers a relayer on-chain with stake, endpoint, and X25519 public key.
2. Wallet creates an escrowed job in `relayerRegistry`.
3. Wallet advertises the job to the gateway.
4. Registered relayers inspect the on-chain job and submit signed bids.
5. Wallet validates bids against on-chain registration and free stake.
6. Wallet encrypts the withdrawal payload to the selected relayer.
7. Relayer decrypts, submits the privacy-pool withdrawal, and earns the fee.

The relayer fee must be less than or equal to the relayer's free stake. A relayer with 0.1 XLM free stake cannot validly bid on a 30 XLM fee.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js 20+ | Required for the relayer workspace. |
| Stellar testnet XLM | Used for stake and transaction fees. |
| Dedicated operator key | Do not reuse the pool admin or deployer key. |
| HTTPS endpoint | Required when the wallet is served over HTTPS. |
| Reverse proxy | Caddy or nginx is recommended. |

## Install

```bash
git clone https://github.com/collinsadi/opaque-stellar.git
cd opaque-stellar/relayer
npm ci
```

## Create Operator Key

```bash
stellar keys generate opaque-relayer --network testnet --fund
stellar keys address opaque-relayer
stellar keys show opaque-relayer
```

Keep the `S...` secret private.

## Derive X25519 Secret

Withdrawal payloads are encrypted to the relayer's X25519 public key. Derive a deterministic 32-byte secret from the operator secret:

```bash
node -e "const {createHash}=require('crypto');const s='YOUR_S_SECRET';console.log(createHash('sha256').update(s).update('opaque-relayer-x25519-v1').digest('hex'))"
```

Store the 64-character hex value as `RELAYER_X25519_SECRET`.

## Configure

Create `stellar/.env` at the repo root:

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Minimum config:

```bash
RELAYER_OPERATOR_SECRET=S...
RELAYER_X25519_SECRET=abcdef0123...
RELAYER_ENDPOINT=https://relayer.example.com
RELAYER_PORT=8787
```

Optional overrides:

```bash
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
RELAYER_REGISTRY_ID=C...
RELAYER_MIN_FEE=100000
RELAYER_DEADLINE_MARGIN_LEDGERS=30
```

`RELAYER_DEADLINE_MARGIN_LEDGERS` is how much deadline headroom a job must still
have before the engine bids on it. Accepting a job commits the operator to two
sequential on-chain transactions — `accept_job`, then `submit_pool_withdraw` — so
the engine declines jobs with less runway than this rather than getting slashed
for a deadline it had no time to meet. The default of 30 ledgers (~2.5 minutes at
Stellar's ~5s cadence) covers accept-plus-submit latency; lower it only if your
RPC confirms transactions faster than that, and never below the margin your own
accept-to-submit path needs. Declined jobs are counted as
`deadlineDeclined` in the engine's `/health` stats.

## Register

Register the operator before expecting bids:

```bash
cd ~/stellar/relayer
set -a
source ../.env
set +a
npm run register
```

The smoke test also registers if needed and verifies the market control plane:

```bash
npm run smoke:market
```

## Standalone Mode

Standalone mode runs one process that includes a local hub, relayer engine, and HTTP gateway:

```bash
cd ~/stellar/relayer
npm run relayer
```

Healthy startup:

```text
Opaque relayer gateway listening on https://relayer.example.com
operator=G...
x25519=0x...
registry=C...
```

Verify:

```bash
curl https://relayer.example.com/health
```

## Shared Hub Mode

Run one public gateway hub:

```bash
cd ~/stellar/relayer
RELAYER_GATEWAY_ENDPOINT=https://gateway.example.com RELAYER_PORT=8787 npm run hub
```

Run each node with outbound hub connection:

```bash
# in stellar/.env
RELAYER_HUB_URL=https://gateway.example.com
RELAYER_ENDPOINT=https://operator-1.example.com

cd ~/stellar/relayer
npm run relayer
```

Only the hub needs to be the public wallet gateway. Each relayer still registers its operator endpoint on-chain as metadata.

## Make Users Avoid Manual Gateway URLs

Set the public gateway once for the frontend:

```bash
# frontend/.env
VITE_RELAYER_GATEWAY_URL=https://gateway.example.com
```

For a repository-wide default, update the manifest:

```json
"gatewayUrls": [
  "https://gateway.example.com"
]
```

The wallet reads gateway URLs through `frontend/src/contracts/relayerConfig.ts`, then uses the first healthy gateway when creating jobs and fetching bids.

## systemd Service

```ini
[Unit]
Description=Opaque Stellar relayer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/home/YOUR_LINUX_USER/stellar/relayer
EnvironmentFile=/home/YOUR_LINUX_USER/stellar/.env
ExecStart=/usr/bin/npm run relayer
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable opaque-relayer
sudo systemctl start opaque-relayer
sudo journalctl -u opaque-relayer -f
```

## Reverse Proxy

Caddy example:

```text
relayer.example.com {
    reverse_proxy localhost:8787
}
```

nginx must disable buffering for streaming endpoints:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
}
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `tsx: not found` | Dependencies missing. | Run `cd relayer && npm ci`. |
| Node starts but never bids | Not registered, wrong X25519 key, wrong endpoint, or fee above free stake. | Run `npm run register`, compare startup `x25519`, and lower fee or increase stake. |
| Wallet says no valid bids | Gateway reached, but no registered relayer produced a valid bid. | Check relayer logs, stake, `RELAYER_MIN_FEE`, and registry record. |
| Payload delivered but no success message | Relayer accepted the payload but submission is still pending or status polling lagged. | Check relayer logs and on-chain job status. |
| Mixed content browser error | HTTPS wallet is calling HTTP gateway. | Use an HTTPS gateway URL. |
| `fee > freeStake` behavior | Registry validation rejects bids that cannot be backed by stake. | Top up relayer stake or offer a smaller fee. |

## Security Notes

The relayer operator key is a hot key with staked XLM. Use a dedicated account, keep `.env` locked down, run as a dedicated Linux user, and rotate immediately if leaked.

## Network Selection and Logs

Set `OPAQUE_NETWORK=testnet` or `OPAQUE_NETWORK=mainnet` before starting the relayer. The service loads `deployments/v1/<network>.json`, uses that manifest's `networkPassphrase`, and fails fast if the selected manifest has not deployed `relayerRegistry` yet. Mainnet remains blocked until its manifest is populated.

Relayer service logs are JSON objects with `ts`, `level`, `service`, `correlationId` when present, and event fields. The shared logger redacts secrets, passphrases, tokens, signatures, and X25519 material.
