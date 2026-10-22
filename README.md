# CodexBar LiteLLM Spend

CodexBar provider plugin that tracks **spend across up to 3 LiteLLM virtual keys**, with daily charts and USD→EUR conversion (ECB via [Frankfurter](https://www.frankfurter.app/)).

This is separate from CodexBar’s built-in **LiteLLM** provider (single key + budgets). Use this when you want multi-account spend.

## Requirements

- [CodexBar](https://github.com/steipete/CodexBar) with user provider plugins
- A LiteLLM proxy URL and virtual API keys that can call `/key/info` (and spend/activity endpoints)

## Install

```bash
mkdir -p ~/.config/codexbar/providers
curl -fsSL -o ~/.config/codexbar/providers/litellm-spend.js \
  https://raw.githubusercontent.com/juansoilan/codexbar-litellm-spend/main/litellm-spend.js
```

Or copy `litellm-spend.js` into `~/.config/codexbar/providers/` manually.

Reload CodexBar (or reopen Settings), then enable **LiteLLM Spend**.

## Configure

In **Settings → Providers → LiteLLM Spend**:

| Field | Description |
| --- | --- |
| Base URL | LiteLLM proxy origin (no trailing `/v1`) |
| Account 1–3 label | Optional display name (empty → LiteLLM `key_alias` / `key_name`) |
| Account 1–3 API key | LiteLLM virtual key |

Approve network access when CodexBar prompts (proxy host + `api.frankfurter.dev`).

## Notes

- API key fields are plain text settings so the plugin can send a different `Authorization` header per account.
- Treat keys as secrets; do not commit them.
- Currency display uses the ECB USD/EUR rate when Frankfurter is reachable; otherwise amounts stay in USD.

## License

MIT
