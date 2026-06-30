# Chuma Backend

REST API for **Chuma** — a carrier-agnostic village banking app for Zambia.
Node.js + Express + MongoDB (Mongoose), with **real PawaPay** (payments) and
**AfricasTalking** (SMS/OTP) integrations.

The business logic (share-out math, loan eligibility, group fees, trust score,
penalties, group stats, approval thresholds) is ported directly from the Chuma
frontend services, so the API produces identical numbers to what the app shows.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#    Edit .env — at minimum set MONGODB_URI and JWT_SECRET.
#    Leave PAYMENTS_ENABLED=false and SMS_ENABLED=false to run fully
#    simulated (no real money/SMS) while you wire things up.

# 3. Seed test data (1 user, 3 groups: paid / grace / locked)
npm run seed

# 4. Run
npm run dev      # auto-reload (nodemon)
# or
npm start
```

Server starts on `http://localhost:5000`. Health check: `GET /api/health`.

---

## Modes: simulated vs live

Two flags in `.env` control whether external calls are real:

| Flag | false (default) | true |
|------|-----------------|------|
| `PAYMENTS_ENABLED` | PawaPay calls are simulated as `ACCEPTED`/`COMPLETED` | Real PawaPay deposits/payouts |
| `SMS_ENABLED` | OTP/SMS logged to console | Real AfricasTalking SMS |

Start with both `false`, confirm the app works end-to-end, then flip on one at
a time as you add credentials.

> In simulated mode, `POST /api/auth/request-otp` returns the OTP in a `devCode`
> field so you can test signup/signin without sending SMS.

---

## Connecting your credentials

### MongoDB
Set `MONGODB_URI` to your Atlas connection string (or local Mongo). That's it.

### AfricasTalking (SMS / OTP)
1. Create an account, grab your **sandbox** API key (`Settings → API Key`).
2. In `.env`: `AT_USERNAME=sandbox`, `AT_API_KEY=<your key>`, `SMS_ENABLED=true`.
3. Test receiving via the AT **simulator** (https://simulator.africastalking.com).
4. For production: register a sender ID (e.g. `CHUMA`), set `AT_SENDER_ID=CHUMA`,
   switch `AT_USERNAME` and `AT_API_KEY` to live values.

### PawaPay (Payments)
1. Create a sandbox account, generate an **API token**.
2. In `.env`:
   ```
   PAWAPAY_BASE_URL=https://api.sandbox.pawapay.io
   PAWAPAY_API_TOKEN=<your token>
   PAYMENTS_ENABLED=true
   ```
3. **Callbacks need a public URL.** Run ngrok:
   ```bash
   ngrok http 5000
   ```
   Take the https URL it gives you (e.g. `https://abc123.ngrok-free.app`) and set:
   ```
   PUBLIC_BASE_URL=https://abc123.ngrok-free.app
   PAWAPAY_DEPOSIT_CALLBACK_URL=https://abc123.ngrok-free.app/api/webhooks/pawapay/deposit
   PAWAPAY_PAYOUT_CALLBACK_URL=https://abc123.ngrok-free.app/api/webhooks/pawapay/payout
   ```
   Also register these callback URLs in your PawaPay dashboard.
4. PawaPay is **asynchronous**: initiating a deposit/payout returns `ACCEPTED`;
   the final `COMPLETED`/`FAILED` arrives at your webhook (handled in
   `src/routes/webhook.routes.js`), which updates the transaction status.

> **Production security TODO:** PawaPay supports signed callbacks (RFC-9421).
> Enable "Only accept signed requests" in the dashboard and implement signature
> verification in `webhook.routes.js` (marked with a TODO) before going live.

### KYC (optional)
If you integrate an NRC verification provider, set `KYC_PROVIDER_BASE_URL`,
`KYC_PROVIDER_API_KEY`, `KYC_ENABLED=true`. Without it, KYC is stored as
`pending`.

---

## Project structure

```
src/
  config/        env loader + Mongo connection
  models/        Mongoose schemas (User, Group, Loan, Transaction,
                 Penalty, Approval, Notification, Otp)
  middleware/    auth (JWT), error handling
  services/
    logic.service.js     ported business math (matches the app exactly)
    pawapay.service.js    real PawaPay deposit/payout integration
    sms.service.js        real AfricasTalking SMS integration
  routes/        auth, groups, contributions, loans, approvals,
                 shareout, misc (penalties/notifications/transactions/
                 reports), webhooks
  utils/         helpers (OTP, invite codes, phone/network), seed script
  server.js      app entry
```

---

## Auth flow

1. `POST /api/auth/request-otp` `{ phone, mode }` → OTP sent (or `devCode` in dev)
2. `POST /api/auth/verify-otp` `{ phone, code, mode }` → returns `{ token }`
   - `mode: "signin"` → `next: "tabs"`
   - `mode: "signup"` → `next: "kyc"`
3. `POST /api/auth/kyc` (Bearer token) → save NRC details
4. `POST /api/auth/pin` (Bearer token) → set app PIN
5. Use the `token` as `Authorization: Bearer <token>` on all other endpoints.

---

## Key endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/request-otp` | Send OTP |
| POST | `/api/auth/verify-otp` | Verify OTP, get token |
| POST | `/api/auth/kyc` | Save KYC/NRC |
| POST | `/api/auth/pin` | Set PIN |
| GET | `/api/auth/me` | Current user |
| PATCH | `/api/auth/profile` | Update profile / preferred payment |
| GET | `/api/groups` | My groups (with fee/lock status) |
| POST | `/api/groups` | Create group (charges K100 month 1) |
| GET | `/api/groups/:id` | Group detail |
| POST | `/api/groups/:id/invite` | Invite by phone (SMS + notification) |
| POST | `/api/groups/:id/accept` | Accept invite |
| GET | `/api/groups/:id/fee` | Fee/lock status, amount owed |
| POST | `/api/groups/:id/fee/pay` | Pay overdue fee (unlocks group) |
| POST | `/api/groups/:id/delete-request` | Request deletion (blocked if open loans/savings) |
| POST | `/api/contributions` | Make a contribution (PawaPay deposit) |
| GET | `/api/loans/eligibility` | Borrowing limit |
| POST | `/api/loans` | Request loan (creates approval) |
| POST | `/api/loans/:id/repay` | Repay loan (full/partial) |
| GET | `/api/loans` | List loans |
| GET | `/api/approvals` | Pending approvals |
| POST | `/api/approvals/:id/vote` | Vote; disburses loan on approval |
| GET | `/api/shareout/:groupId` | Computed share-out |
| POST | `/api/shareout/:groupId/distribute` | Pay out shares, reset cycle |
| GET | `/api/penalties` | Penalties (mine / by group) |
| POST | `/api/penalties/detect/:groupId` | Run violation detection |
| POST | `/api/penalties/:id/pay` | Pay a penalty |
| GET | `/api/notifications` | My notifications |
| PATCH | `/api/notifications/:id/read` | Mark read |
| PATCH | `/api/notifications/read-all` | Mark all read |
| GET | `/api/transactions` | My transactions (filter by group/type/range) |
| GET | `/api/reports/:groupId` | Computed group analytics |
| POST | `/api/webhooks/pawapay/deposit` | PawaPay deposit callback |
| POST | `/api/webhooks/pawapay/payout` | PawaPay payout callback |

---

## Connecting the Expo app

Point the app's API base URL at this server:
- Local device on same network: `http://<your-LAN-ip>:5000/api`
- Via ngrok: `https://<ngrok>.ngrok-free.app/api`

Replace the app's `src/data/mock/*` reads with `fetch`/axios calls to these
endpoints, attaching the JWT from login as a Bearer token. The response shapes
match the app's existing types, so wiring is a data-source swap, not a rewrite.

---

## Notes & TODOs

- **Idempotency:** PawaPay deposit/payout IDs are UUIDs generated per request.
- **Status reconciliation:** implement a periodic job to poll
  `checkDepositStatus`/`checkPayoutStatus` for any transaction stuck `pending`
  (PawaPay best practice — see `implementation` docs).
- **Signed callbacks:** verify RFC-9421 signatures in `webhook.routes.js`.
- **Scheduled penalty detection:** call `POST /api/penalties/detect/:groupId`
  from a cron job (e.g. node-cron) against real overdue data.
- **Fee lock cron:** a daily job can send grace-period reminders and lock groups
  past grace (logic already in `logic.service.js`).
```
