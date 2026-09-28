# Comfystep

Arabic-first mobile storefront for Comfystep orthopedic insoles, including quantity pricing, cash-on-delivery checkout, persistent orders, and customer order confirmation pages.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/comfora-storefront/src/App.tsx` — existing storefront, checkout sheet, and order confirmation route.
- `artifacts/comfora-storefront/src/index.css` — mobile RTL visual system and checkout/order page styling.
- `artifacts/api-server/src/routes/orders.ts` — order creation and token lookup endpoints.
- `artifacts/api-server/src/lib/orders.ts` — server-owned pricing, delivery constants, order formatting, and Sheet sync retry logic.
- `lib/db/src/schema/orders.ts` — persistent order records and Sheet synchronization state.
- `lib/api-spec/openapi.yaml` — source-of-truth API contract for orders.

## Architecture decisions

- Order totals are recomputed from the pair count on the server; browser-submitted prices are never trusted.
- Sequential order numbers are protected by a PostgreSQL advisory transaction lock, while the customer-facing route uses an unguessable UUID token.
- Google Sheet forwarding is best-effort: the order is saved first, and failed syncs remain retryable without blocking customer confirmation.
- Delivery is represented as messaging only; shipping is persisted and sent to the Sheet as an empty string, with no delivery amount in totals.

## Product

- Customers choose one, two, or three pairs with independent colors and sizes.
- Customers complete a mobile RTL checkout with Jordanian phone validation, governorate selection, honeypot protection, and cash-on-delivery payment.
- Customers are redirected to a tokenized confirmation page that reloads its order details from the database.

## User preferences

- Preserve the uploaded Comfystep storefront design and existing functionality; extend it instead of rebuilding it.

## Gotchas

- Run API codegen after changing `lib/api-spec/openapi.yaml`.
- The storefront is intentionally mobile-first and capped at 430px.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
