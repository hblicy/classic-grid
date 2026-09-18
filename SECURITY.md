# Security Policy

- Never commit `.env`, `secrets/`, `data/`, private keys, API secrets, or Telegram tokens/chat IDs.
- Only commit `.env.example` with **empty** secret values. Fill real keys on your machine after `cp .env.example .env`.
- If you find a secret in this repository, open an issue **without pasting the secret**, and rotate the credential immediately.
- README dashboard image is a UI screenshot (no tokens/addresses). Never paste live credentials into Issues/PRs.

## Dashboard

- Without `DASHBOARD_TOKEN`, the dashboard only listens on `127.0.0.1`.
- Remote listening requires a `DASHBOARD_TOKEN` of at least 16 characters. The dashboard uses HTTP Basic Auth; keep the token out of URLs, logs, screenshots, and source control.
- Do not expose the dashboard directly to the public internet. Use an authenticated SSH tunnel, Tailscale network, or a TLS reverse proxy with access control.
- PopDEX stores only the Agent private key. Never enter or save the main wallet private key in this project.
