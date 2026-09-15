/**
 * keyboards/admin.js
 * ------------------------------------------------------------------
 * Inline keyboards shown to the admin only.
 * ------------------------------------------------------------------
 */

const { Markup } = require("telegraf");

function adminHome() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📦 Products", "admin:products"), Markup.button.callback("👥 Users", "admin:users")],
    [Markup.button.callback("🌍 Countries", "admin:countries"), Markup.button.callback("🔌 Providers", "admin:providers")],
    [Markup.button.callback("💳 Deposits", "admin:deposits"), Markup.button.callback("🛒 Orders", "admin:orders")],
    [Markup.button.callback("📊 Statistics", "admin:stats"), Markup.button.callback("📢 Broadcast", "admin:broadcast")],
    [Markup.button.callback("⚙ Settings", "admin:settings")],
    [Markup.button.callback("🏠 Home", "menu_home")],
  ]);
}

function backToAdminHome() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅ Admin Home", "admin:home")]]);
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "flow_cancel")]]);
}

// ---------------- Countries ----------------
function countriesMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🖥️ Server 1",
        "admin:countries:server1"
      ),
    ],
    [
      Markup.button.callback(
        "🖥️ Server 2",
        "admin:countries:server2"
      ),
    ],
    [
      Markup.button.callback(
        "⬅ Admin Home",
        "admin:home"
      ),
    ],
  ]);
}
function server1CountriesMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "➕ Add Country",
        "admin:countries:server1:add"
      ),
    ],
    [
      Markup.button.callback(
        "📋 Country List",
        "admin:countries:server1:list"
      ),
    ],
    [
      Markup.button.callback(
        "🔎 Search Country",
        "admin:countries:server1:search"
      ),
    ],
    [
      Markup.button.callback(
        "⬅ Countries",
        "admin:countries"
      ),
    ],
  ]);
}
function countryListKeyboard(countries) {
  const rows = countries.map((c) => [
    Markup.button.callback(`${c.emoji || "🌍"} ${c.name} (${c.status})`, `admin:countries:view:${c.id}`),
  ]);
  rows.push([Markup.button.callback("⬅ Countries Menu", "admin:countries")]);
  return Markup.inlineKeyboard(rows);
}

function countryDetailKeyboard(country) {
  const toggle =
    country.status === "enabled"
      ? Markup.button.callback("🔴 Disable", `admin:countries:disable:${country.id}`)
      : Markup.button.callback("🟢 Enable", `admin:countries:enable:${country.id}`);

  return Markup.inlineKeyboard([
    [Markup.button.callback("✏ Edit Name", `admin:countries:edit:${country.id}`)],
    [toggle],
    [Markup.button.callback("❌ Delete", `admin:countries:delete:${country.id}`)],
    [Markup.button.callback("⬅ Country List", "admin:countries:list")],
  ]);
}

function confirmDeleteCountryKeyboard(countryId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚠️ Confirm Delete", `admin:countries:delete_confirm:${countryId}`)],
    [Markup.button.callback("❌ Cancel", `admin:countries:view:${countryId}`)],
  ]);
}

// ---------------- Providers ----------------

function providersMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💰 Provider Balance", "admin:providers:balance")],
    [Markup.button.callback("📊 Provider Details", "admin:providers:details")],
    [Markup.button.callback("⬅ Admin Home", "admin:home")],
  ]);
}

function providerListKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💰 Check Balance", "admin:providers:balance")],
    [Markup.button.callback("⬅ Providers Menu", "admin:providers")],
  ]);
}

function providerDetailKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💰 Check Balance", "admin:providers:balance")],
    [Markup.button.callback("⬅ Providers Menu", "admin:providers")],
  ]);
}

// ---------------- Products ----------------

function productsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Product", "admin:products:add")],
    [Markup.button.callback("📋 Product List", "admin:products:list")],
    [Markup.button.callback("⬅ Admin Home", "admin:home")],
  ]);
}

function productListKeyboard(
  products,
  page = 1,
  total = products.length,
  search = ""
) {
  const PAGE_SIZE = 40;

  const totalPages = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE)
  );

  const rows = [];

  // PRODUCT BUTTONS — 2 PER ROW
  for (let i = 0; i < products.length; i += 2) {
    const row = [];

    for (let j = i; j < Math.min(i + 2, products.length); j++) {
      const product = products[j];

      const countryName = String(
        product.countryName || product.name || ""
      )
        .replace(/^🌍\s*/u, "")
        .replace(/Telegram\s*/i, "")
        .trim();

      row.push(
        Markup.button.callback(
          `${countryName} — ₹${Number(
            product.finalPrice || 0
          ).toFixed(2)}`,
          `admin:products:view:${product.id}`
        )
      );
    }

    rows.push(row);
  }

  // SEARCH — directly below product buttons
  rows.push([
    Markup.button.callback(
      "🔎 Search Product",
      "admin:products:search"
    ),
  ]);

  // PAGINATION
  const navigation = [];

  if (page > 1) {
    navigation.push(
      Markup.button.callback(
        "⬅️ Previous",
        `admin:products:page:${page - 1}${search ? `:${encodeURIComponent(search)}` : ""}`
      )
    );
  }

  if (page < totalPages) {
    navigation.push(
      Markup.button.callback(
        "Next ➡️",
        `admin:products:page:${page + 1}${search ? `:${encodeURIComponent(search)}` : ""}`
      )
    );
  }

  if (navigation.length) {
    rows.push(navigation);
  }

  // ADMIN ACTIONS — LAST
  rows.push([
    Markup.button.callback(
      "🗑️ Delete All Products",
      "admin:products:deleteall"
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "⬅️ Products Menu",
      "admin:products"
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

function productDetailKeyboard(product) {
  const toggle =
    product.status === "enabled"
      ? Markup.button.callback(
          "🔴 Disable",
          `admin:products:disable:${product.id}`
        )
      : Markup.button.callback(
          "🟢 Enable",
          `admin:products:enable:${product.id}`
        );

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "📝 Edit Name",
        `admin:products:editname:${product.id}`
      ),
      Markup.button.callback(
        "😀 Edit Emoji",
        `admin:products:editemoji:${product.id}`
      ),
    ],
    [
      Markup.button.callback(
        "📄 Description",
        `admin:products:editdescription:${product.id}`
      ),
      Markup.button.callback(
        "📈 Profit Margin",
        `admin:products:margin:${product.id}`
      ),
    ],
    [
      Markup.button.callback(
        "🔧 Service Code",
        `admin:products:editservice:${product.id}`
      ),
      Markup.button.callback(
        "🌍 Country",
        `admin:products:editcountry:${product.id}`
      ),
    ],
    [
      toggle,
      Markup.button.callback(
        "❌ Delete",
        `admin:products:delete:${product.id}`
      ),
    ],
    [
      Markup.button.callback(
        "⬅ Product List",
        "admin:products:list"
      ),
    ],
  ]);
}

function countryPickerKeyboard(countries, callbackPrefix) {
  const rows = countries.map((c) => [
    Markup.button.callback(`${c.emoji || "🌍"} ${c.name}`, `${callbackPrefix}:${c.id}`),
  ]);
  rows.push([Markup.button.callback("❌ Cancel", "flow_cancel")]);
  return Markup.inlineKeyboard(rows);
}

function providerPickerKeyboard(providers, callbackPrefix) {
  const rows = providers.map((p) => [Markup.button.callback(p.name, `${callbackPrefix}:${p.id}`)]);
  rows.push([Markup.button.callback("Skip (no provider)", `${callbackPrefix}:none`)]);
  rows.push([Markup.button.callback("❌ Cancel", "flow_cancel")]);
  return Markup.inlineKeyboard(rows);
}

function priceModeKeyboard(callbackPrefix) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("MANUAL", `${callbackPrefix}:MANUAL`),
      Markup.button.callback("API", `${callbackPrefix}:API`),
    ],
    [Markup.button.callback("❌ Cancel", "flow_cancel")],
  ]);
}

// ---------------- Users ----------------

function usersMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📋 User List", "admin:users:list:1")],
    [Markup.button.callback("🏆 Top 10 Depositors", "admin:users:top")],
    [Markup.button.callback("🔎 Search User", "admin:users:search")],
    [Markup.button.callback("⬅ Admin Home", "admin:home")],
  ]);
}

function userDetailKeyboard(user) {
  const banToggle = user.banned
    ? Markup.button.callback(
        "✅ Unban",
        `admin:users:unban:${user.telegramId}`
      )
    : Markup.button.callback(
        "🚫 Ban",
        `admin:users:ban:${user.telegramId}`
      );

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
       "📥 Deposit History",
       `admin:users:deposits:${user.telegramId}:1`
       ),
      Markup.button.callback(
        "🛒 Order History",
       `admin:users:orders:${user.telegramId}:1`
        ),
    ],
    [
      Markup.button.callback(
        "💰 Add Balance",
        `admin:users:addbal:${user.telegramId}`
      ),
      Markup.button.callback(
        "💸 Remove Balance",
        `admin:users:removebal:${user.telegramId}`
      ),
    ],
    [banToggle],
    [
      Markup.button.callback(
        "👥 Referral Rate",
        `admin:users:referral:${user.telegramId}`
      ),
    ],
    [
      Markup.button.callback(
        "⬅ Users List",
        "admin:users:list:1"
      ),
    ],
  ]);
}

// ---------------- Deposits ----------------

function depositAdminKeyboard(depositId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Approve", `admin:deposits:approve:${depositId}`),
      Markup.button.callback("❌ Reject", `admin:deposits:reject:${depositId}`),
    ],
  ]);
}

function depositsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📋 Pending Deposits", "admin:deposits:list")],
    [Markup.button.callback("⬅ Admin Home", "admin:home")],
  ]);
}

function depositListKeyboard(deposits) {
  const rows = deposits.map((d) => [
    Markup.button.callback(`₹${d.amount} — ${d.userId}`, `admin:deposits:view:${d.depositId}`),
  ]);
  rows.push([Markup.button.callback("⬅ Deposits Menu", "admin:deposits")]);
  return Markup.inlineKeyboard(rows);
}

// ---------------- Orders ----------------

function ordersMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🖥️ Server 1 Orders", "admin:server1:orders")],
    [Markup.button.callback("⬅ Admin Home", "admin:home")],
  ]);
}

function server1OrderDetailMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "⬅ Processing Orders",
        "admin:server1:orders:processing"
      ),
    ],
    [
      Markup.button.callback(
        "⬅ Server 1 Orders",
        "admin:server1:orders"
      ),
    ],
  ]);
}

function server1OrdersMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Statistics", "admin:server1:stats")],
    [Markup.button.callback("📅 Today's Statistics", "admin:server1:today_stats")],
    [Markup.button.callback("📋 All Orders", "admin:server1:orders:all")],
    [Markup.button.callback("⏳ Processing", "admin:server1:orders:processing")],
    [Markup.button.callback("✅ Completed", "admin:server1:orders:completed")],
    [Markup.button.callback("❌ Cancelled / Refunded", "admin:server1:orders:refunded")],
    [Markup.button.callback("📵 No Number", "admin:server1:orders:no_number")],
    [Markup.button.callback("⚠️ Manual Review", "admin:server1:orders:manual_review")],
    [Markup.button.callback("⬅ Orders Menu", "admin:orders")],
  ]);
}

function orderListKeyboard(orders) {
  const rows = orders.map((o) => [
    Markup.button.callback(`${o.productName} — ${o.userId}`, `admin:orders:view:${o.orderId}`),
  ]);
  rows.push([Markup.button.callback("⬅ Orders Menu", "admin:orders")]);
  return Markup.inlineKeyboard(rows);
}

function orderDetailKeyboard(order) {
  if (order.status !== "processing") {
    return Markup.inlineKeyboard([[Markup.button.callback("⬅ Order List", "admin:orders:list")]]);
  }
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Mark Completed", `admin:orders:complete:${order.orderId}`)],
    [Markup.button.callback("❌ Cancel & Refund", `admin:orders:cancel:${order.orderId}`)],
    [Markup.button.callback("⬅ Order List", "admin:orders:list")],
  ]);
}

// ---------------- Settings ----------------

function settingsMenu(settings = {}) {
  const server1 = settings.server1Enabled !== false;
  const server2 = settings.server2Enabled !== false;

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "💰 Product Pricing",
        "admin:settings:productPricing"
      ),
    ],
    [Markup.button.callback("📢 Force-Join Channel", "admin:settings:forceChannel")],
    [Markup.button.callback("📢 Sales Channel", "admin:settings:salesChannel")],
    [Markup.button.callback("🆘 Support Username", "admin:settings:supportUsername")],
    [Markup.button.callback("💵 Minimum Deposit", "admin:settings:minimumDeposit")],
    [Markup.button.callback("👥 Referral Commission", "admin:settings:referral")],
    [Markup.button.callback("📊 Referral Statistics", "admin:settings:referralStats")],
    [Markup.button.callback("🏦 UPI ID", "admin:settings:upiId")],
    [
      Markup.button.callback(
        "⏳ Server 1 OTP Wait Time",
        "admin:settings:server1OtpWait"
      ),
    ],
    [
      Markup.button.callback(
        "🛠️ Toggle Maintenance",
        "admin:settings:toggleMaintenance"
      ),
    ],
    [
      Markup.button.callback(
        `🖥️ S1 ${server1 ? "🟢 ON" : "🔴 OFF"}`,
        "admin:settings:toggleServer1"
      ),
      Markup.button.callback(
        `🖥️ S2 ${server2 ? "🟢 ON" : "🔴 OFF"}`,
        "admin:settings:toggleServer2"
      ),
    ],
    [Markup.button.callback("⬅️ Admin Home", "admin:home")],
  ]);
}
module.exports = {
  adminHome,
  backToAdminHome,
  cancelKeyboard,
  countriesMenu,
  countryListKeyboard,
  countryDetailKeyboard,
  confirmDeleteCountryKeyboard,
  providersMenu,
  providerListKeyboard,
  providerDetailKeyboard,
  productsMenu,
  productListKeyboard,
  productDetailKeyboard,
  countryPickerKeyboard,
  providerPickerKeyboard,
  priceModeKeyboard,
  usersMenu,
  userDetailKeyboard,
  depositAdminKeyboard,
  depositsMenu,
  depositListKeyboard,
  ordersMenu,
  server1OrdersMenu,
  server1OrderDetailMenu,
  orderListKeyboard,
  orderDetailKeyboard,
  server1CountriesMenu,
  settingsMenu,
};
