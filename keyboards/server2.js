const { Markup } = require("telegraf");

function server2Home() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🌍 Countries", "s2:admin:countries")],
    [Markup.button.callback("📦 Stock", "s2:admin:stock")],
    [Markup.button.callback("🛒 Orders", "s2:admin:orders")],
    [Markup.button.callback("📊 Statistics", "s2:admin:stats")],
    [Markup.button.callback("⬅ Admin Home", "admin:home")],
  ]);
}

function server2CountryMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Country", "s2:admin:country:add")],
    [Markup.button.callback("📋 Country List", "s2:admin:countries:list")],
    [Markup.button.callback("⬅ Server 2", "s2:admin:home")],
  ]);
}

function server2CountryList(countries) {
  const rows = countries.map(c => [
    Markup.button.callback(
      `${c.emoji || "🌍"} ${c.name} — ${c.status || "enabled"}`,
      `s2:admin:country:view:${c.id}`
    )
  ]);
  rows.push([Markup.button.callback("⬅ Server 2", "s2:admin:home")]);
  return Markup.inlineKeyboard(rows);
}

function server2CountryDetail(c) {
  const toggle = c.status === "enabled"
    ? Markup.button.callback("🔴 Disable", `s2:admin:country:toggle:${c.id}`)
    : Markup.button.callback("🟢 Enable", `s2:admin:country:toggle:${c.id}`);
  return Markup.inlineKeyboard([
    [toggle, Markup.button.callback("❌ Delete", `s2:admin:country:delete:${c.id}`)],
    [Markup.button.callback("⬅ Country List", "s2:admin:countries:list")],
  ]);
}

function server2StockMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Add Stock", "s2:admin:stock:add")],
    [Markup.button.callback("📋 Available Stock", "s2:admin:stock:list:available")],
    [Markup.button.callback("📋 All Stock", "s2:admin:stock:list:all")],
    [Markup.button.callback("⬅ Server 2", "s2:admin:home")],
  ]);
}

function server2StockList(items) {
  const rows = items.map(s => [
    Markup.button.callback(
      `${s.countryEmoji || "🌍"} ${s.name || s.number || s.stockId} — ₹${Number(s.price || 0).toFixed(2)}`,
      `s2:admin:stock:view:${s.stockId}`
    )
  ]);
  rows.push([Markup.button.callback("⬅ Stock", "s2:admin:stock")]);
  return Markup.inlineKeyboard(rows);
}

function server2StockDetail(s) {
  const rows = [];
  if (s.status === "available") {
    rows.push([Markup.button.callback("✏️ Edit Price", `s2:admin:stock:price:${s.stockId}`)]);
  }
  rows.push([Markup.button.callback("❌ Delete", `s2:admin:stock:delete:${s.stockId}`)]);
  rows.push([Markup.button.callback("⬅ Stock", "s2:admin:stock")]);
  return Markup.inlineKeyboard(rows);
}

function server2OrdersMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⏳ Pending", "s2:admin:orders:pending"), Markup.button.callback("⚙️ Processing", "s2:admin:orders:processing")],
    [Markup.button.callback("✅ Completed", "s2:admin:orders:completed"), Markup.button.callback("❌ Cancelled", "s2:admin:orders:cancelled")],
    [Markup.button.callback("📋 All Orders", "s2:admin:orders:all")],
    [Markup.button.callback("⬅ Server 2", "s2:admin:home")],
  ]);
}

function server2OrderList(orders) {
  const rows = orders.map(o => [
    Markup.button.callback(
      `${o.orderId.slice(0, 8)} — ${o.userId} — ₹${Number(o.amount || 0).toFixed(2)}`,
      `s2:admin:order:view:${o.orderId}`
    )
  ]);
  rows.push([Markup.button.callback("⬅ Orders", "s2:admin:orders")]);
  return Markup.inlineKeyboard(rows);
}

function server2OrderDetail(o) {
  const rows = [];
  if (o.status === "pending") {
    rows.push([Markup.button.callback("⚙️ Mark Processing", `s2:admin:order:processing:${o.orderId}`)]);
  }
  if (o.status === "processing") {
    rows.push([Markup.button.callback("✅ Complete", `s2:admin:order:complete:${o.orderId}`)]);
    rows.push([Markup.button.callback("❌ Cancel + Refund", `s2:admin:order:cancel:${o.orderId}`)]);
  }
  rows.push([Markup.button.callback("⬅ Orders", "s2:admin:orders")]);
  return Markup.inlineKeyboard(rows);
}

function server2UserHome() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🌍 Browse Countries", "s2:user:countries")],
    [Markup.button.callback("📦 My Server 2 Orders", "s2:user:orders")],
    [Markup.button.callback("🏠 Main Menu", "menu_home")],
  ]);
}

function server2UserCountries(countries) {
  const rows = countries.map(c => [
    Markup.button.callback(`${c.emoji || "🌍"} ${c.name}`, `s2:user:country:${c.id}`)
  ]);
  rows.push([Markup.button.callback("⬅ Server 2", "s2:user:home")]);
  return Markup.inlineKeyboard(rows);
}

function server2UserStock(items) {
  const rows = items.map(s => [
    Markup.button.callback(
      `${s.name || s.number || "Stock"} — ₹${Number(s.price || 0).toFixed(2)}`,
      `s2:user:buy:${s.stockId}`
    )
  ]);
  rows.push([Markup.button.callback("⬅ Countries", "s2:user:countries")]);
  return Markup.inlineKeyboard(rows);
}

function server2Confirm(stockId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirm Purchase", `s2:user:confirm:${stockId}`)],
    [Markup.button.callback("⬅ Back", "s2:user:countries")],
  ]);
}

function server2UserOrders(orders) {
  const rows = orders.map(o => [
    Markup.button.callback(
      `${o.orderId.slice(0, 8)} — ${o.status} — ₹${Number(o.amount || 0).toFixed(2)}`,
      `s2:user:order:${o.orderId}`
    )
  ]);
  rows.push([Markup.button.callback("⬅ Server 2", "s2:user:home")]);
  return Markup.inlineKeyboard(rows);
}

module.exports = {
  server2Home, server2CountryMenu, server2CountryList, server2CountryDetail,
  server2StockMenu, server2StockList, server2StockDetail,
  server2OrdersMenu, server2OrderList, server2OrderDetail,
  server2UserHome, server2UserCountries, server2UserStock, server2Confirm,
  server2UserOrders,
};
