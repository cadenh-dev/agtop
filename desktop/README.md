# agtop GPUI desktop

Run `bun run desktop:build` and `bun run desktop` from the repository root. The launcher starts the existing TypeScript manager, opens this native window, and cleans up session-owned jobs when the window exits.

- `src/ui.rs`: native layout, selection, full-text filters, searchable harness picker, launch form, and stop confirmation.
- `src/client.rs`: authenticated loopback API requests on a worker thread.
- `src/model.rs`: API models, argument validation, and process-tree ordering.
- `src/input.rs`: native text input with selection, clipboard, and IME support, adapted from GPUI's Apache-licensed example.
- `src/theme.rs`: shared colors and fonts.

For an externally managed backend, start `agtop daemon`, then run `agtop-desktop --port 13309 --token-file PATH`. Never put the token itself in command arguments. Network proxies and redirects are disabled for the local control API.

The app uses GPUI 0.2.2 directly, without an embedded browser. See the root README for build prerequisites, controls, and containment limits.
