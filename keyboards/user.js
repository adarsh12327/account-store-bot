/**
 * User-facing keyboards. Designed to keep the store UI compact and fast.
 */
const { Markup } = require("telegraf");
function mainMenu(isAdmin = false) {
  const buttons = [\n    [\n      Markup.button.callback("🖥️ Server 2", "menu_server2")\n    ],
    [
      Markup.button.callback("📱 Buy Telegram Accounts", "menu_buy")
    ],
    [
      Markup.button.callback("💰 My Wallet", "menu_wallet"),
      Markup.button.callback("➕ Deposit", "menu_deposit")
    ],
    [
      Markup.button.callback("📦 My Orders", "menu_orders"),
      Markup.button.callback("📢 Sales", "menu_sales")
    ],
    [
      Markup.button.callback("👥 Refer & Earn", "menu_referral")
    ],
    [
      Markup.button.callback("🆘 Support", "menu_support")
    ]
  ];

  if (isAdmin) {
    buttons.push([
      Markup.button.callback("⚙️ Admin Panel", "admin:home")
    ]);
  }

  return Markup.inlineKeyboard(buttons);
}

function backToMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "menu_home")]]);
}

function forceJoinKeyboard(channel) {
  const channelUrl = channel.startsWith("@") ? `https://t.me/${channel.slice(1)}` : channel;
  return Markup.inlineKeyboard([
    [Markup.button.url("📢 Join Channel", channelUrl)],
    [Markup.button.callback("✅ Verify", "verify_join")],
  ]);
}

function walletMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📜 Transaction History", "wallet_history")],
    [Markup.button.callback("💳 Deposit", "menu_deposit")],
    [Markup.button.callback("🏠 Main Menu", "menu_home")],
  ]);
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "flow_cancel")]]);
}

function depositConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Submit Deposit Request", "deposit_submit")],
    [Markup.button.callback("❌ Cancel", "flow_cancel")],
  ]);
}

function twoColumn(items, makeButton) {
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const row = [makeButton(items[i])];
    if (items[i + 1]) row.push(makeButton(items[i + 1]));
    rows.push(row);
  }
  return rows;
}

function countryListKeyboard(countries, prefix = "buy_country") {
  const rows = twoColumn(countries, (c) =>
    Markup.button.callback(`${c.emoji || "🌍"} ${c.name}`, `${prefix}:${c.id}`)
  );
  rows.push([Markup.button.callback("🏠 Main Menu", "menu_home")]);
  return Markup.inlineKeyboard(rows);
}

function productListKeyboard(products, countryId) {
  const rows = twoColumn(products, (p) =>
    Markup.button.callback(`${p.name} · ₹${p.finalPrice}`, `buy_product:${p.id}`)
  );
  rows.push([Markup.button.callback("⬅ Back to Countries", "menu_buy")]);
  return Markup.inlineKeyboard(rows);
}

function productConfirmKeyboard(productId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirm Purchase", `buy_confirm:${productId}`)],
    [Markup.button.callback("⬅ Back", "menu_buy")],
  ]);
}

function ordersListKeyboard(orders) {
  const rows = orders.map((o) => [
    Markup.button.callback(`${o.productName} — ${o.status}`, `order_view:${o.orderId}`),
  ]);
  rows.push([Markup.button.callback("🏠 Main Menu", "menu_home")]);
  return Markup.inlineKeyboard(rows);
}

module.exports = {
  mainMenu,
  backToMenu,
  forceJoinKeyboard,
  walletMenu,
  cancelKeyboard,
  depositConfirmKeyboard,
  countryListKeyboard,
  productListKeyboard,
  productConfirmKeyboard,
  ordersListKeyboard,
};
