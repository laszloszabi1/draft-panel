# rm-panel

Draft call-center teljesítmény-dashboard. Napi frissülés (GitHub Actions cron 06:20 RO),
statikus GitHub Pages, **PIN-titkosított** adat (AES-GCM) — a nyers számok soha nem kerülnek
a publikus HTML-be, csak helyes PIN-nel fejthetők vissza a böngészőben.

## Működés
- `generate.mjs` — lekéri az élő adatot (Shopify Draft Orders + Orders, Cargus AwbTrace),
  kiszámolja a metrikákat, **titkosítja** a `DASHBOARD_PIN`-nel, és beágyazza az
  `index.template.html`-be → `index.html`.
- A GitHub Actions minden nap lefuttatja és Pages-re deployolja.

## Secrets (repo Settings → Secrets and variables → Actions)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — adat-hozzáférés (creds-vault).
- `DASHBOARD_PIN` — a belépő PIN.

## Kézi build
`DASHBOARD_PIN=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node generate.mjs`
