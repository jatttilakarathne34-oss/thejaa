# BillEase — POS & Business Management (Vercel + PostgreSQL)

Node.js + Express backend, PostgreSQL database, plain-JS frontend. All permissions are enforced on the server.
Every completed order is saved to the database **together with its A4 PDF invoice** (table `order_pdfs`).

## Deploy on Vercel
1. Put this folder in a GitHub repository (or use the Vercel CLI: `vercel`).
2. vercel.com → **Add New → Project** → import the repository. Vercel detects Express automatically; no build settings needed.
3. Open the project → **Storage** tab → create/connect **Neon (Serverless Postgres)**. Pick the region closest to you (Singapore for Sri Lanka) and connect it to the project. Vercel adds `DATABASE_URL` for you.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variable is picked up.
5. Open your site. The first visit shows **Setup**: create the Owner account. The database tables are created automatically on the first request.
6. Optional: add `JWT_SECRET` (any long random text) under Settings → Environment Variables. If you don't, one is generated and stored in the database.

`vercel.json` sets the function region to `sin1` (Singapore). Keep the function region and the database region the same, because it makes every action noticeably faster. Change it if your database is elsewhere.

## Run locally
    npm install
    npm start        # http://localhost:3000  (embedded PostgreSQL stored in ./data/pgdata)
    npm test         # 65 end-to-end checks
To use a real Postgres locally, set `DATABASE_URL` first. `npm test` runs against embedded Postgres, or against `DATABASE_URL` if set (use a throw-away database: the test creates users and orders).

## How it works on Vercel
* **Database:** one PostgreSQL database holds users, products, orders, customers, payments, stock, activity logs **and the invoice PDFs**.
* **Invoice PDFs:** created when the order is saved and stored in the database (one per order, never duplicated). A cancelled order's PDF is re-issued with a CANCELLED stamp. Old invoices do not change when you edit business details. The 57mm receipt is generated on demand from the same order.
* **Live updates:** Vercel functions cannot hold connections open, so screens check for new events every 4 seconds (owner/manager) or 15 seconds (employees), only while the tab is visible. The order is already in the database and its PDF is ready when the owner's screen is notified.
* **No duplicates:** each order carries a unique reference from the phone; double taps and retries return the same invoice. Stock is deducted atomically, so two phones can never sell the same last item.
* **Safety copy:** Settings → *Download full data export (JSON)*. Restore points come from your database provider (Neon dashboard).

## Roles
| | Owner | Manager | Employee |
|---|---|---|---|
| Billing / POS | yes | yes | yes |
| Change discounts at billing | yes | yes | only if granted (otherwise the product's own discount applies) |
| Add / edit / archive products | yes | only if granted | no |
| Cancel orders | yes | only if granted | no |
| Stock, customers, creditors, reports | yes | yes (default) | only if granted |
| Create users | managers + employees | employees only | no |
| Settings, data export | yes | no | no |

Orders are never deleted. They are cancelled (reason required, stock restored, logged). Users are deactivated, which logs them out immediately. Errors go to the `error_logs` table and to Vercel's runtime logs.

## Costs and limits
Vercel and Neon both have free tiers with usage limits. The polling above makes one small request every few seconds per open owner/manager screen. Bluetooth printing and phone cameras need HTTPS, which Vercel provides automatically.
