# Security

## Reporting

If you discover a security issue, please do not open a public issue. Instead, contact the maintainer privately.

Maintainer: Charles Chern @AIlinker

## Operational notes

- **Never commit `.env`** (it may contain `FEISHU_APP_SECRET`).
- Treat inbound Feishu messages and files as **untrusted input**.
- Consider enabling Feishu **Verification Token** and (optionally) **Encrypt Key**.
- Set reasonable limits:
  - `FEISHU_MAX_DOWNLOAD_BYTES`
  - your tunnel / reverse-proxy rate limits
