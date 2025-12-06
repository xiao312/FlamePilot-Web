# Photon Charging (Dev Testing)

Use this to verify photon charging locally without touching real billing.

## Dev Mock Setup (no real billing)
1. Set env vars (in `.env` or your shell):
   ```bash
   PHOTON_DEV_MODE=1
   PHOTON_MOCK=1
   DEV_ACCESS_KEY=your-dev-access-key
   CLIENT_NAME=your-client-name
   SKU_ID=your-sku-id
   ```
   `PHOTON_MOCK=1` ensures no external calls are made.

2. Run the app:
   ```bash
   npm run dev
   ```

3. Trigger a chat:
   - Send any prompt; when the CLI process exits, the server computes a photon charge.
   - Check server logs for `[DEV-MOCK] Would charge X photons (skuId=...)`.
   - The chat UI shows a photon-charge system message with token/photons (mocked).

## Hitting the Dev Endpoint (real call in dev mode)
- Keep `PHOTON_DEV_MODE=1` but set `PHOTON_MOCK=0` (or unset it).
- Ensure `DEV_ACCESS_KEY`, `CLIENT_NAME`, and `SKU_ID` are valid.
- On chat completion, the server calls the Photon API; confirm via server logs and the chat system message.

## Notes
- Billing runs only if all credentials are present and `skuId` isn’t a placeholder.
- Charges are computed on CLI process exit using reported token counts.
- There is no HTTP timeout in the current implementation; prefer `PHOTON_MOCK=1` while testing.
