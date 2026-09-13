# Account Store Bot

A Telegram store bot built with **Node.js (CommonJS)**, **Telegraf**, and **Firebase Cloud Firestore**.

## What this bot does

- User registration, wallet, and deposit approval workflow
- Admin panel: users, countries, providers, products, orders, deposits, statistics, broadcast, settings
- Force-join and maintenance mode
- A manual-fulfillment order system: a buyer pays from their wallet balance, and an admin
  manually marks the order completed (typing in delivery info) or cancels it with a refund

## What this bot deliberately does NOT do

This build intentionally leaves out automated provider/account-delivery integration
(no `services/grizzly.js`, no virtual-number purchasing, no OTP/account delivery,
no automated verified-account reselling). Country and Provider management exist only
as **data/catalog fields** — nothing in this project calls out to any external
provider API. If you need automated fulfillment for a specific, legitimate product,
that would need to be built and reviewed separately.

## 1. Requirements

- Node.js 18 or newer (check with `node -v`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Firebase project with Firestore enabled, and a service account key JSON file

## 2. Install

```bash
cd account-store-bot
npm install
```

## 3. Firebase setup

Place your Firebase service account key file at the project root, named exactly:

```
serviceAccountKey.json
```

`firebase.js` already expects it there. **Never commit this file** — it's in `.gitignore`.

## 4. Environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env
```

Edit `.env`:

```
BOT_TOKEN=your_bot_token_from_botfather
ADMIN_ID=your_telegram_numeric_id
```

To find your numeric Telegram ID, message [@userinfobot](https://t.me/userinfobot).

## 5. Start the bot

```bash
node bot.js
```

You should see `Bot started.` in the console.

## 6. Stop the bot

Press `Ctrl+C` in the terminal. On a VPS running it in the background (e.g. via `pm2` or `screen`),
stop it via that tool instead.

## 7. Configure the admin

The admin is whoever's Telegram ID matches `ADMIN_ID` in `.env`. Only that account can open the
admin panel via the `/admin` command.

## 8. Configure a provider (data record only)

Admin Panel → 🔌 Providers → ➕ Add Provider. This just stores a name/URL/API key as a labeled
record for your own bookkeeping — it is not called by the bot.

## 9. Configure products

1. Admin Panel → 🌍 Countries → ➕ Add Country (create at least one)
2. Admin Panel → 📦 Products → ➕ Add Product → follow the prompts (pick country, optionally a
   provider record, price mode, price, stock)

## 10. Test deposit flow

1. As a normal user: 💳 Deposit → enter an amount ≥ the configured minimum → enter a UTR/reference
2. Confirm the request — the admin account receives a message with ✅ Approve / ❌ Reject buttons
3. Approve it, then check 👤 Profile or 💰 Wallet as the user — balance should reflect the deposit
4. Try tapping ✅ Approve a second time (e.g. via an old message) — it should say the deposit was
   already processed and must NOT add balance again

## 11. Test wallet

💰 Wallet shows current balance, total deposited, and pending deposit. 📜 Transaction History lists
the most recent transactions (deposits, admin adjustments, purchases, refunds).

## 12. Test orders

1. As a user with balance: 🛒 Buy Accounts → pick a country → pick a product → ✅ Confirm Purchase
2. Balance should be deducted immediately and stock reduced by 1
3. As admin: Admin Panel → 🛒 Orders → 📋 Processing Orders → open the order →
   ✅ Mark Completed (type delivery info) — the buyer receives it, or
   ❌ Cancel & Refund — the buyer's balance and the product's stock are restored

## 13. Security notes

- `BOT_TOKEN`, Firebase credentials, and provider API keys are never logged or shown to
  non-admin users. Provider API keys are masked in the admin UI (`****last4`).
- All balance changes go through Firestore transactions in `database.js` — a user's balance
  can never go negative, and deposit/order actions can't be double-processed.
- Only the Telegram ID in `ADMIN_ID` can access any `admin:*` action or the `/admin` command;
  everyone else gets "⛔ Access Denied".

## 14. Known limitations

- Multi-step flows (deposit amount → UTR, admin add-product forms, etc.) use in-memory session
  state. If the bot process restarts mid-flow, that one in-progress flow is lost — the user just
  starts it again. This does not affect any already-saved data.
- User/order/deposit listings are capped (not paginated) — fine for small-to-medium catalogs;
  a growing store should add pagination.
- Username search in the admin panel does a bounded scan (first 500 users) since Firestore has
  no native "contains" search — fine at small scale.

## 15. Deploying

### GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

Because `.env` and `serviceAccountKey.json` are gitignored, you'll need to add them manually
(never commit them) on whatever machine/host you deploy to.

### Render / VPS

1. Push the code (without `.env` / `serviceAccountKey.json`) to your host
2. Upload `serviceAccountKey.json` securely (e.g. via the host's file manager or a secrets volume)
3. Set `BOT_TOKEN` and `ADMIN_ID` as environment variables in the host's dashboard
4. Set the start command to `node bot.js` (or `npm start`)
5. Use a process manager (Render does this automatically; on a raw VPS use `pm2 start bot.js` or a
   `systemd` service) so the bot restarts automatically if it crashes or the server reboots
