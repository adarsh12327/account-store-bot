/**
 * handlers/adminProducts.js
 * ------------------------------------------------------------------
 * 📦 Product manager (admin only). Catalog management only — prices
 * are set manually by the admin (even in "API" mode, the apiPrice
 * field is just a number the admin types in; nothing calls out to
 * any external API).
 *
 * Add-product flow mixes callback steps (country/provider/price-mode
 * pickers) with text steps (name/price/stock) — all tracked via
 * utils/session.js.
 * ------------------------------------------------------------------
 */

const { Markup } = require("telegraf");
const db = require("../database");
const { createProductsBatch } = db;
const logger = require("../utils/logger");
const session = require("../utils/session");
const { requireAdmin } = require("./admin");
const { parseText, parseAmount, parseInt0Plus } = require("../utils/validation");
const { escapeHtml, formatAmount } = require("../utils/helpers");
const { getServicePrice, getPrices } = require("../services/grizzlyClient");
const {
  invalidateServer1CatalogCache,
  loadServer1Catalog,
} = require("./server1");
const {
  productsMenu,
  productListKeyboard,
  productDetailKeyboard,
  countryPickerKeyboard,
  providerPickerKeyboard,
  priceModeKeyboard,
  cancelKeyboard,
} = require("../keyboards/admin");

async function updateProductAndInvalidate(productId, updates = {}) {
  await db.updateProduct(productId, updates);
  invalidateServer1CatalogCache();
}


// ==========================================================
// ADMIN UI MESSAGE HELPER
// ==========================================================
// Prefer editing the existing admin panel message.
// If Telegram does not allow editing it, delete the old
// message first and then send a new one.

async function editAdminMessage(ctx, text, extra = {}) {
  const telegramId = ctx.from?.id;

  // 1. If this action came from an inline button,
  // edit that exact message and remember it as the current UI.
  if (ctx.callbackQuery?.message) {
    try {
      const message = await ctx.editMessageText(text, extra);

      if (telegramId && ctx.callbackQuery.message) {
        session.setMessage(
          telegramId,
          ctx.callbackQuery.message
        );
      }

      return message;
    } catch (_) {
      // Continue to saved-message fallback.
    }
  }

  // 2. Try the previously saved UI message.
  const saved = telegramId
    ? session.getMessage(telegramId)
    : null;

  if (saved?.chatId && saved?.messageId) {
    try {
      await ctx.telegram.editMessageText(
        saved.chatId,
        saved.messageId,
        undefined,
        text,
        extra
      );

      return {
        chat: { id: saved.chatId },
        message_id: saved.messageId,
      };
    } catch (_) {
      // Edit failed. Remove the old UI message.
      try {
        await ctx.telegram.deleteMessage(
          saved.chatId,
          saved.messageId
        );
      } catch (_) {}
    }
  }

  // 3. Do not create another UI message.
  // The admin panel must stay in the existing Telegram message.
  return null;
}

function registerAdminProductsHandler(bot) {
  bot.action("admin:products", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;
      await editAdminMessage(
        ctx,
        "📦 <b>Product Manager</b>",
        {
          parse_mode: "HTML",
          ...productsMenu(),
        }
      );
    } catch (err) {
      logger.error("Error in admin:products action", err);
    }
  });

  // ==========================================================
  // PRODUCT LIST / SEARCH / PAGINATION
  // ==========================================================

  async function showProductList(ctx, page = 1, search = "") {
    const allProducts = await db.listProducts();

    const query = String(search || "")
      .trim()
      .toLowerCase();

    const filtered = query
      ? allProducts.filter((p) => {
          const text = [
            p.name,
            p.countryName,
            p.serviceCode,
            p.providerId,
            p.countryId,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return text.includes(query);
        })
      : allProducts;

    const PAGE_SIZE = 40;

    const totalPages = Math.max(
      1,
      Math.ceil(filtered.length / PAGE_SIZE)
    );

    page = Math.min(
      Math.max(Number(page) || 1, 1),
      totalPages
    );

    const startIndex = (page - 1) * PAGE_SIZE;

    const pageProducts = filtered.slice(
      startIndex,
      startIndex + PAGE_SIZE
    );

    // ----------------------------------------------------------
    // GRIZZLY DATA
    // ----------------------------------------------------------
    // Load cached/live Grizzly data so admin can see
    // the actual API stock instead of Firestore stock: 0.

    let grizzlyCatalog = [];
    let grizzlyStale = false;

    try {
      const result = await loadServer1Catalog({
        forceRefresh: false,
      });

      grizzlyCatalog = Array.isArray(result?.catalog)
        ? result.catalog
        : [];

      grizzlyStale = Boolean(result?.stale);
    } catch (err) {
      logger.warn(
        "Admin product list: Server 1 catalog unavailable:",
        err.message
      );
    }

    // ----------------------------------------------------------
    // LOAD COUNTRIES
    // ----------------------------------------------------------

    let countries = [];

    try {
      countries =
        await db.listServer1Countries({
          onlyEnabled: false,
        });
    } catch (err) {
      logger.warn(
        "Admin product list: country loading failed:",
        err.message
      );
    }

    const countryMap = new Map();

    for (const country of countries) {
      const id =
        country.id ||
        country.countryId ||
        country.countryCode;

      if (id != null) {
        countryMap.set(
          String(id),
          country
        );
      }
    }

    // ----------------------------------------------------------
    // BUILD PRODUCT LIST
    // ----------------------------------------------------------

    const lines = [
      "📋 <b>Product List</b>"
    ];

    try {
      await editAdminMessage(
        ctx,
        lines.join("\n"),
        {
          parse_mode: "HTML",
          ...productListKeyboard(
            pageProducts,
            page,
            filtered.length,
            query
          ),
        }
      );
    } catch (err) {
      logger.error(
        "Admin product list update failed",
        err
      );
    }
  }

  bot.action("admin:products:list", async (ctx) => {
    try {
      try {
        await ctx.answerCbQuery();
      } catch (_) {
        // Callback query may already be expired/answered.
        // Continue opening the Product List normally.
      }

      if (!(await requireAdmin(ctx))) return;

      const products = await db.listProducts();

      if (!products.length) {
        await editAdminMessage(
          ctx,
          "📋 <b>Product List</b>\n\n" +
          "❌ No products found.",
          {
            parse_mode: "HTML",
            ...productListKeyboard([], 1, 0),
          }
        );
        return;
      }

      await showProductList(ctx, 1);

    } catch (err) {
      logger.error(
        "Error in admin:products:list action",
        err
      );
    }
  });

  // ==========================================================
  // PRODUCT PAGINATION
  // ==========================================================

  bot.action(
    /^admin:products:page:(\d+)(?::(.+))?$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const page = Number(ctx.match[1]);

        let search = "";

        if (ctx.match[2]) {
          try {
            search = decodeURIComponent(ctx.match[2]);
          } catch (_) {
            search = ctx.match[2];
          }
        }

        await showProductList(ctx, page, search);

      } catch (err) {
        logger.error(
          "Error in product pagination",
          err
        );
      }
    }
  );

  // ==========================================================
  // SEARCH PRODUCT
  // ==========================================================

  bot.action(
    "admin:products:search",
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        session.set(ctx.from.id, {
          step: "admin_product_search",
          data: {},
        });

        await ctx.reply(
          "🔎 <b>Search Product</b>\n\n" +
          "Enter country or product name.\n\n" +
          "Example:\n" +
          "<code>India</code>\n" +
          "<code>USA</code>\n" +
          "<code>Telegram India</code>\n" +
          "<code>tg</code>",
          {
            parse_mode: "HTML",
            ...cancelKeyboard(),
          }
        );

      } catch (err) {
        logger.error(
          "Error starting product search",
          err
        );
      }
    }
  );

  // ==========================================================
  // DELETE ALL PRODUCTS
  // ==========================================================

  bot.action(
    "admin:products:deleteall",
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const products = await db.listProducts();

        if (!products.length) {
          await ctx.answerCbQuery(
            "Product list is already empty."
          );
          return;
        }

        await ctx.editMessageText(
          "⚠️ <b>DELETE ALL PRODUCTS?</b>\n\n" +
          `📦 Products: <b>${products.length}</b>\n\n` +
          "❗ This action cannot be undone.",
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  Markup.button.callback(
                    "🗑️ YES, DELETE ALL",
                    "admin:products:deleteall:confirm"
                  ),
                ],
                [
                  Markup.button.callback(
                    "❌ Cancel",
                    "admin:products:list"
                  ),
                ],
              ],
            },
          }
        );

      } catch (err) {
        logger.error(
          "Error opening delete all confirmation",
          err
        );
      }
    }
  );

  bot.action(
    "admin:products:deleteall:confirm",
    async (ctx) => {
      // Answer callback immediately.
      ctx.answerCbQuery("Deleting products...").catch(() => {});

      try {
        if (!(await requireAdmin(ctx))) return;

        // Fast Firestore batch deletion.
        const deleted = await db.deleteAllProducts();

        await ctx.editMessageText(
          "✅ <b>All Products Deleted</b>\n\n" +
          `🗑️ Deleted: <b>${deleted}</b>`,
          {
            parse_mode: "HTML",
            ...productsMenu(),
          }
        );

      } catch (err) {
        logger.error(
          "Error deleting all products",
          err
        );

        try {
          await ctx.reply(
            "❌ Failed to delete all products.\n\n" +
            escapeHtml(err.message || "Unknown error")
          );
        } catch (_) {}
      }
    }
  );

  bot.action(
    "admin:products:noop",
    async (ctx) => {
      await ctx.answerCbQuery();
    }
  );

  // ==========================================================
  // PRODUCT ADD MENU
  // ==========================================================

  bot.action("admin:products:add", async (ctx) => {
    try {
      try {
        await ctx.answerCbQuery();
      } catch (_) {
        // Callback query may already be expired/answered.
        // Continue opening the Product List normally.
      }

      if (!(await requireAdmin(ctx))) return;

      await ctx.editMessageText(
        "📦 <b>Add Product</b>\n\nSelect server:",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🖥️ Server 1",
                  callback_data: "admin:products:add:server:1",
                },
                {
                  text: "🖥️ Server 2",
                  callback_data: "admin:products:add:server:2",
                },
              ],
              [
                {
                  text: "⬅️ Products",
                  callback_data: "admin:products",
                },
              ],
            ],
          },
        }
      );

    } catch (err) {
      logger.error("Error in admin:products:add action", err);
    }
  });


  // ==========================================================
  // SERVER SELECTION
  // ==========================================================

  bot.action(
    /^admin:products:add:server:(1|2)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const server = ctx.match[1];

        await ctx.editMessageText(
          `🖥️ <b>Server ${server}</b>\n\nSelect product creation mode:`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "➕ Manual Add",
                    callback_data:
                      `admin:products:add:mode:manual:${server}`,
                  },
                ],
                [
                  {
                    text: "⚡ Auto Generate All",
                    callback_data:
                      `admin:products:add:mode:auto:${server}`,
                  },
                ],
                [
                  {
                    text: "⬅️ Select Server",
                    callback_data: "admin:products:add",
                  },
                ],
              ],
            },
          }
        );

      } catch (err) {
        logger.error(
          "Error selecting product server",
          err
        );
      }
    }
  );


  // ==========================================================
  // MANUAL PRODUCT — COUNTRY SELECT
  // ==========================================================

  bot.action(
    /^admin:products:add:mode:manual:(1|2)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const server = ctx.match[1];

        const countries =
          server === "1"
            ? await db.listServer1Countries({
                onlyEnabled: true,
              })
            : await db.listCountries();

        if (!countries.length) {
          await ctx.editMessageText(
            `⚠️ <b>Server ${server}</b> has no enabled countries.`,
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "⬅️ Back",
                      callback_data:
                        `admin:products:add:server:${server}`,
                    },
                  ],
                ],
              },
            }
          );
          return;
        }

        session.set(ctx.from.id, {
          step: "admin_product_new_country",
          data: {
            server,
          },
        });

        const rows = [];
        const pageSize = 2;

        for (let i = 0; i < countries.length; i += pageSize) {
          rows.push(
            countries.slice(i, i + pageSize).map((c) => ({
              text:
                `${c.emoji || "🌍"} ` +
                `${c.countryName || c.name || "Unknown"}`,
              callback_data:
                `admin:products:newcountry:${server}:${c.id || c.countryCode}`,
            }))
          );
        }

        rows.push([
          {
            text: "⬅️ Back",
            callback_data:
              `admin:products:add:server:${server}`,
          },
        ]);

        await ctx.editMessageText(
          `🌍 <b>Server ${server} — Select Country</b>\n\n` +
          "Product name, service code and description will be generated automatically.",
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: rows,
            },
          }
        );

      } catch (err) {
        logger.error(
          "Error opening manual product country picker",
          err
        );
      }
    }
  );


  // ==========================================================
  // AUTO GENERATE ALL — SERVER 1
  // ==========================================================

  bot.action(
    "admin:products:add:mode:auto:1",
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const settings = await db.getSettings();

        const usdRate = Number(settings.usdRate || 0);
        const marginPercent = Number(settings.profit || 0);

        if (usdRate <= 0) {
          await ctx.editMessageText(
            "⚠️ <b>USD Rate Not Configured</b>\n\n" +
            "Admin → Settings से USD Rate set करें।",
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  {
                    text: "⬅️ Server 1",
                    callback_data:
                      "admin:products:add:server:1",
                  },
                ]],
              },
            }
          );
          return;
        }

        const countries =
          await db.listServer1Countries({
            onlyEnabled: true,
          });

        if (!countries.length) {
          await ctx.editMessageText(
            "⚠️ No enabled Server 1 countries found."
          );
          return;
        }

        await ctx.editMessageText(
          "🔄 <b>Live Product Generation</b>\n\n" +
          `🌍 Countries: <b>${countries.length}</b>\n` +
          "🔑 Service: <code>tg</code>\n" +
          "💵 Fetching Grizzly prices once...",
          {
            parse_mode: "HTML",
          }
        );

        /*
         * IMPORTANT:
         * Fetch complete Grizzly price catalogue ONLY ONCE.
         * Do NOT call getServicePrice() inside the country loop,
         * because getServicePrice() itself calls getPrices().
         */
        const prices = await getPrices();

        const root =
          prices && typeof prices === "object"
            ? prices
            : {};

        const description =
          "📱 Telegram Account • ⚡ Fast & Reliable";

        let created = 0;
        let skipped = 0;
        let failed = 0;

        const failedCountries = [];
        const productsToCreate = [];

        // Load existing products ONCE instead of querying Firestore
        // separately for every country.
        const existingProducts = await db.listProducts();

        const existingKeys = new Set(
          existingProducts
            .filter(
              (product) =>
                product.serviceCode === "tg" &&
                product.providerId === "grizzly"
            )
            .map(
              (product) =>
                String(product.countryId)
            )
        );

        for (const country of countries) {
          const countryId =
            country.id || country.countryCode;

          const countryName =
            country.countryName ||
            country.name ||
            "Unknown Country";

          const emoji =
            country.emoji || "🌍";

          const countryCode = String(
            country.countryCode ||
            country.code ||
            ""
          ).trim();

          if (!countryCode) {
            failed++;
            failedCountries.push(
              `${emoji} ${countryName} — no country code`
            );
            continue;
          }

          try {
            /*
             * Find:
             * country.service
             * country:service
             * country -> service
             * service -> country
             */
            const candidates = [];

            if (
              root[countryCode] &&
              root[countryCode].tg
            ) {
              candidates.push(
                root[countryCode].tg
              );
            }

            if (
              root[`${countryCode}.tg`]
            ) {
              candidates.push(
                root[`${countryCode}.tg`]
              );
            }

            if (
              root[`${countryCode}:tg`]
            ) {
              candidates.push(
                root[`${countryCode}:tg`]
              );
            }

            if (
              root.tg &&
              root.tg[countryCode]
            ) {
              candidates.push(
                root.tg[countryCode]
              );
            }

            const priceItem =
              candidates.find(
                (item) =>
                  item &&
                  Number.isFinite(
                    Number(item.cost)
                  )
              );

            if (!priceItem) {
              failed++;
              failedCountries.push(
                `${emoji} ${countryName} (${countryCode}) — TG price unavailable`
              );

              logger.warn(
                `Grizzly TG price unavailable: ${countryName} [${countryCode}]`
              );

              continue;
            }

            const costUsd =
              Number(priceItem.cost);

            if (
              !Number.isFinite(costUsd) ||
              costUsd <= 0
            ) {
              failed++;
              failedCountries.push(
                `${emoji} ${countryName} (${countryCode}) — invalid TG price`
              );

              logger.warn(
                `Invalid Grizzly TG price: ${countryName} [${countryCode}]`
              );

              continue;
            }

            // Check duplicate from the single product read above.
            if (existingKeys.has(String(countryId))) {
              skipped++;
              continue;
            }

            /*
             * USD → INR → Margin
             */
            const costInr =
              costUsd * usdRate;

            const finalPrice = costInr + (costInr * marginPercent / 100);

            productsToCreate.push({
              name:
                `${emoji} Telegram ${countryName}`,

              description,

              serviceCode: "tg",

              countryId,

              providerId: "grizzly",

              priceMode: "API",

              providerUsdPrice:
                costUsd,

              usdRate,

              marginPercent,

              apiPrice:
                Number(
                  finalPrice.toFixed(2)
                ),

              manualPrice: 0,

              stock: 0,
            });

            created++;

          } catch (err) {
            failed++;

            failedCountries.push(
              `${emoji} ${countryName} (${countryCode})`
            );

            logger.error(
              `Live price failed: ${countryName} [${countryCode}]`,
              err
            );
          }
        }

        // Create all new products using Firestore batch writes.
        if (productsToCreate.length > 0) {
          await createProductsBatch(productsToCreate);
        }

        session.clear(ctx.from.id);

        let result =
          "✅ <b>Live Product Generation Complete</b>\n\n" +
          `🌍 Total Countries: <b>${countries.length}</b>\n` +
          `✅ Created: <b>${created}</b>\n` +
          `⏭️ Already Exists: <b>${skipped}</b>\n` +
          `❌ Failed: <b>${failed}</b>\n\n` +
          "🔑 Service: <code>tg</code>\n" +
          `💱 USD Rate: ₹${usdRate.toFixed(2)}\n` +
          `📈 Margin: ${marginPercent.toFixed(2)}%`;

        if (failedCountries.length) {
          result +=
            "\n\n❌ <b>Failed Countries</b>\n" +
            failedCountries
              .slice(0, 15)
              .map(
                (x) =>
                  `• ${escapeHtml(x)}`
              )
              .join("\n");

          if (failedCountries.length > 15) {
            result +=
              `\n• ...and ${
                failedCountries.length - 15
              } more`;
          }
        }

        await ctx.reply(
          result,
          {
            parse_mode: "HTML",
            ...productsMenu(),
          }
        );

      } catch (err) {
        session.clear(ctx.from.id);

        logger.error(
          "Error in live auto product generation",
          err
        );

        await ctx.reply(
          "❌ <b>Product generation failed.</b>\n\n" +
          escapeHtml(
            err.message ||
            "Unknown error"
          ),
          {
            parse_mode: "HTML",
            ...productsMenu(),
          }
        );
      }
    }
  );

  // ==========================================================
  // MANUAL PRODUCT — COUNTRY SELECTED
  // ==========================================================

  // ==========================================================
  // MANUAL PRODUCT — COUNTRY SELECTED
  // ==========================================================

  bot.action(
    /^admin:products:newcountry:(1|2):(.+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const server = ctx.match[1];
        const countryId = ctx.match[2];

        // Live Grizzly pricing is currently supported for Server 1.
        if (server !== "1") {
          await ctx.reply(
            "⚠️ Live provider pricing is currently available for Server 1 only."
          );
          return;
        }

        const country =
          await db.getServer1Country(countryId);

        if (!country) {
          await ctx.reply("❌ Country not found.");
          return;
        }

        const countryName =
          country.countryName ||
          country.name ||
          "Unknown Country";

        const emoji =
          country.emoji || "🌍";

        const countryCode = String(
          country.countryCode ||
          country.code ||
          ""
        ).trim();

        if (!countryCode) {
          await ctx.reply(
            "❌ Country code is missing for this country."
          );
          return;
        }

        const settings =
          await db.getSettings();

        const usdRate =
          Number(settings.usdRate || 0);

        const marginPercent =
          Number(settings.profit || 0);

        if (usdRate <= 0) {
          await ctx.reply(
            "⚠️ USD Rate is not configured.\n\n" +
            "Go to Admin → Settings and set the USD Rate first.",
            cancelKeyboard()
          );
          return;
        }

        await ctx.editMessageText(
          `🔄 <b>Fetching Live Price...</b>\n\n` +
          `${emoji} ${escapeHtml(countryName)}\n` +
          `🔑 Service: <code>tg</code>`,
          { parse_mode: "HTML" }
        );

        const live =
          await getServicePrice(
            "tg",
            countryCode
          );

        const costInr =
          live.costUsd * usdRate;

        const finalPrice = costInr + (costInr * marginPercent / 100);

        const description =
          "📱 Telegram Account • ⚡ Fast & Reliable";

        const existing =
          await db.listProducts({
            countryId,
          });

        const duplicate =
          existing.find(
            (p) =>
              p.serviceCode === "tg" &&
              p.providerId === "grizzly"
          );

        if (duplicate) {
          await ctx.editMessageText(
            "⚠️ <b>Product Already Exists</b>\n\n" +
            `${emoji} ${escapeHtml(countryName)}\n` +
            "🔑 Service: <code>tg</code>",
            {
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[
                  {
                    text: "⬅️ Server 1",
                    callback_data:
                      "admin:products:add:server:1",
                  },
                ]],
              },
            }
          );
          return;
        }

        const product =
          await db.createProduct({
            name:
              `${emoji} Telegram ${countryName}`,

            description,
            serviceCode: "tg",
            countryId,
            providerId: "grizzly",
            priceMode: "API",

            providerUsdPrice:
              live.costUsd,

            usdRate,
            marginPercent,

            apiPrice:
              Number(finalPrice.toFixed(2)),

            manualPrice: 0,
            stock: 0,
          });

        session.clear(ctx.from.id);

        await ctx.editMessageText(
          `✅ <b>Product Created</b>\n\n` +
          `${escapeHtml(product.name)}\n\n` +
          `🔑 Service: <code>tg</code>\n` +
          `📝 ${escapeHtml(description)}\n` +
          `🌍 Country Code: <code>${escapeHtml(countryCode)}</code>\n\n` +
          `💵 <b>Source Cost:</b> $${live.costUsd.toFixed(4)}\n` +
          `💱 USD Rate: ₹${usdRate.toFixed(2)}\n` +
          `📈 Margin: ${marginPercent.toFixed(2)}%\n` +
          `💰 Selling Price: ₹${finalPrice.toFixed(2)}\n` +
          `📦 Available: ${live.count.toLocaleString()}`,
          {
            parse_mode: "HTML",
            ...productsMenu(),
          }
        );

      } catch (err) {
        logger.error(
          "Error creating live manual product",
          err
        );

        await ctx.reply(
          "❌ Failed to create product.\n\n" +
          escapeHtml(
            err.message || "Unknown error"
          ),
          productsMenu()
        );
      }
    }
  );

  bot.action(/^admin:products:add:country:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const state = session.get(ctx.from.id);
      if (!state || state.step !== "admin_product_add_pick_country") return;

      state.data.countryId = ctx.match[1];
      const providers = await db.listProviders();

      if (providers.length === 0) {
        state.data.providerId = null;
        state.step = "admin_product_add_pick_pricemode";
        session.set(ctx.from.id, state);
        await ctx.reply("Select price mode:", priceModeKeyboard("admin:products:add:pricemode"));
        return;
      }

      state.step = "admin_product_add_pick_provider";
      session.set(ctx.from.id, state);
      await ctx.reply("Select a provider (optional):", providerPickerKeyboard(providers, "admin:products:add:provider"));
    } catch (err) {
      logger.error("Error in admin:products:add:country action", err);
    }
  });

  bot.action(/^admin:products:add:provider:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const state = session.get(ctx.from.id);
      if (!state || state.step !== "admin_product_add_pick_provider") return;

      const providerId = ctx.match[1];
      state.data.providerId = providerId === "none" ? null : providerId;
      state.step = "admin_product_add_pick_pricemode";
      session.set(ctx.from.id, state);

      await ctx.reply("Select price mode:", priceModeKeyboard("admin:products:add:pricemode"));
    } catch (err) {
      logger.error("Error in admin:products:add:provider action", err);
    }
  });

  bot.action(/^admin:products:add:pricemode:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const state = session.get(ctx.from.id);
      if (!state || state.step !== "admin_product_add_pick_pricemode") return;

      state.data.priceMode = ctx.match[1] === "API" ? "API" : "MANUAL";
      state.step = "admin_product_add_price";
      session.set(ctx.from.id, state);

      await ctx.reply("Enter the price (₹):", cancelKeyboard());
    } catch (err) {
      logger.error("Error in admin:products:add:pricemode action", err);
    }
  });

  bot.action(/^admin:products:view:(.+)$/, async (ctx) => {
    try {
      // Callback may be expired if Telegram delivered it late.
      // Do not let an expired callback break Product View.
      try {
        await ctx.answerCbQuery();
      } catch (cbErr) {
        logger.warn(
          "Admin product view: callback already expired:",
          cbErr.message
        );
      }

      if (!(await requireAdmin(ctx))) return;

      const product = await db.getProduct(ctx.match[1]);
      if (!product) {
        await ctx.reply("Product not found.", productsMenu());
        return;
      }

      const country = await db.getCountry(product.countryId);
      const apiCost = Number(product.providerUsdPrice) > 0
        ? Number(product.providerUsdPrice)
        : Number(product.apiPrice) || 0;

      const text =
        `📦 <b>${escapeHtml(product.name)}</b>\n\n` +
        `🌍 Country: <b>${escapeHtml(country?.name || "N/A")}</b>\n` +
        `💰 Selling Price: <b>₹${formatAmount(product.finalPrice)}</b>\n` +
        `💵 API Cost: <b>$${apiCost.toFixed(2)}</b>\n` +
        `📈 Profit Margin: <b>${Number(product.marginPercent || 0).toFixed(2)}%</b>\n\n` +
        `📦 Stock: <b>${product.stock}</b>\n` +
        `⚙️ Price Mode: <b>${escapeHtml(product.priceMode || "N/A")}</b>\n` +
        `🟢 Status: <b>${product.status === "enabled" ? "Enabled" : "Disabled"}</b>`;

      await ctx.editMessageText(text, {
  parse_mode: "HTML",
  ...productDetailKeyboard(product),
});
    } catch (err) {
      logger.error("Error in admin:products:view action", err);
    }
  });

  bot.action(/^admin:products:editname:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;
      session.set(ctx.from.id, {
        step: "admin_product_edit_name",
        data: { productId: ctx.match[1] },
      });

      const prompt = await ctx.reply(
        "✏️ <b>Edit Product Name</b>\n\nEnter the new product name:",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

      session.setMessage(ctx.from.id, prompt);
    } catch (err) {
      logger.error("Error in admin:products:editname action", err);
    }
  });

  // ==========================================================
  // EDIT PRODUCT — EMOJI
  // ==========================================================

  bot.action(/^admin:products:editemoji:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const productId = ctx.match[1];
      const product = await db.getProduct(productId);

      if (!product) {
        await ctx.reply("❌ Product not found.");
        return;
      }

      session.set(ctx.from.id, {
        step: "admin_product_edit_emoji",
        data: { productId },
      });

      const prompt = await ctx.reply(
        "😀 <b>Edit Emoji</b>\n\n" +
        "Send the new emoji.\n\n" +
        "Example: 🇮🇳",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

      session.setMessage(ctx.from.id, prompt);
    } catch (err) {
      logger.error("Error opening emoji edit", err);
    }
  });


  // ==========================================================
  // EDIT PRODUCT — DESCRIPTION
  // ==========================================================

  bot.action(/^admin:products:editdescription:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const productId = ctx.match[1];
      const product = await db.getProduct(productId);

      if (!product) {
        await ctx.reply("❌ Product not found.");
        return;
      }

      session.set(ctx.from.id, {
        step: "admin_product_edit_description",
        data: { productId },
      });

      const prompt = await ctx.reply(
        "📄 <b>Edit Description</b>\n\n" +
        "Send the new product description.",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

      session.setMessage(ctx.from.id, prompt);
    } catch (err) {
      logger.error("Error opening description edit", err);
    }
  });


  // ==========================================================
  // EDIT PRODUCT — PROFIT MARGIN
  // ==========================================================

  bot.action(/^admin:products:margin:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const productId = ctx.match[1];
      const product = await db.getProduct(productId);

      if (!product) {
        await ctx.reply("❌ Product not found.");
        return;
      }

      session.set(ctx.from.id, {
        step: "admin_product_edit_margin",
        data: { productId },
      });

      const prompt = await ctx.reply(
        "📈 <b>Edit Profit Margin</b>\n\n" +
        `Current Margin: <b>${Number(product.marginPercent || 0).toFixed(2)}%</b>\n\n` +
        "Enter the new margin percentage.\n" +
        "Example: <code>40</code>",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

      session.setMessage(ctx.from.id, prompt);
    } catch (err) {
      logger.error("Error opening margin edit", err);
    }
  });


  // ==========================================================
  // EDIT PRODUCT — SERVICE CODE
  // ==========================================================

  bot.action(/^admin:products:editservice:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const productId = ctx.match[1];
      const product = await db.getProduct(productId);

      if (!product) {
        await ctx.reply("❌ Product not found.");
        return;
      }

      session.set(ctx.from.id, {
        step: "admin_product_edit_service",
        data: { productId },
      });

      const prompt = await ctx.reply(
        "🔧 <b>Edit Service Code</b>\n\n" +
        `Current: <code>${escapeHtml(product.serviceCode || "tg")}</code>\n\n` +
        "Enter the new service code.\n" +
        "Example: <code>tg</code>",
        {
          parse_mode: "HTML",
          ...cancelKeyboard(),
        }
      );

      session.setMessage(ctx.from.id, prompt);
    } catch (err) {
      logger.error("Error opening service code edit", err);
    }
  });


  // ==========================================================
  // EDIT PRODUCT — COUNTRY
  // ==========================================================

  bot.action(/^admin:products:editcountry:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const productId = ctx.match[1];
      const product = await db.getProduct(productId);

      if (!product) {
        await ctx.reply("❌ Product not found.");
        return;
      }

      const countries = await db.listServer1Countries({
        onlyEnabled: true,
      });

      if (!countries.length) {
        await ctx.reply("❌ No enabled countries available.");
        return;
      }

      session.set(ctx.from.id, {
        step: "admin_product_edit_country",
        data: { productId },
      });

      const rows = [];

      for (const country of countries) {
        rows.push([
          Markup.button.callback(
            `${country.emoji || "🌍"} ${country.countryName || country.name || "Unknown"}`,
            `admin:products:editcountryselect:${productId}:${country.id || country.countryCode}`
          ),
        ]);
      }

      rows.push([
        Markup.button.callback(
          "❌ Cancel",
          "flow_cancel"
        ),
      ]);

      await ctx.reply(
        "🌍 <b>Edit Country</b>\n\nSelect the new country:",
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: rows,
          },
        }
      );
    } catch (err) {
      logger.error("Error opening country edit", err);
    }
  });


  // ==========================================================
  // EDIT PRODUCT — COUNTRY SELECTED
  // ==========================================================

  bot.action(
    /^admin:products:editcountryselect:(.+):(.+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const productId = ctx.match[1];
        const countryId = ctx.match[2];

        const product = await db.getProduct(productId);

        if (!product) {
          await ctx.reply("❌ Product not found.");
          return;
        }

        const country = await db.getServer1Country(countryId);

        if (!country) {
          await ctx.reply("❌ Country not found.");
          return;
        }

        await updateProductAndInvalidate(productId, {
          countryId,
        });

        session.clear(ctx.from.id);

        const updated = await db.getProduct(productId);

        await ctx.editMessageText(
          `✅ <b>Country updated successfully.</b>\n\n` +
          `🌍 ${escapeHtml(country.countryName || country.name || "Unknown")}`,
          {
            parse_mode: "HTML",
            ...productDetailKeyboard(updated),
          }
        );
      } catch (err) {
        logger.error("Error updating product country", err);
      }
    }
  );


  bot.action(/^admin:products:enable:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Enabled");
      if (!(await requireAdmin(ctx))) return;
      await updateProductAndInvalidate(ctx.match[1], { status: "enabled" });
      const product = await db.getProduct(ctx.match[1]);
      await ctx.editMessageText(
  `🟢 ${escapeHtml(product.name)} enabled.`,
  productDetailKeyboard(product)
);
    } catch (err) {
      logger.error("Error in admin:products:enable action", err);
    }
  });

  bot.action(/^admin:products:disable:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Disabled");
      if (!(await requireAdmin(ctx))) return;
      await updateProductAndInvalidate(ctx.match[1], { status: "disabled" });
      const product = await db.getProduct(ctx.match[1]);
      await ctx.editMessageText(
  `🔴 ${escapeHtml(product.name)} disabled.`,
  productDetailKeyboard(product)
);
    } catch (err) {
      logger.error("Error in admin:products:disable action", err);
    }
  });

  bot.action(/^admin:products:delete:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Deleted");
      if (!(await requireAdmin(ctx))) return;
      await db.deleteProduct(ctx.match[1]);
      await ctx.editMessageText(
  "❌ Product deleted.",
  productsMenu()
);
    } catch (err) {
      logger.error("Error in admin:products:delete action", err);
    }
  });

  const textSteps = {

    admin_product_search: async (ctx, state) => {
      const query = String(
        ctx.message.text || ""
      ).trim();

      if (!query) {
        await ctx.reply(
          "❌ Please enter a search term.",
          cancelKeyboard()
        );
        return;
      }

      session.clear(ctx.from.id);

      const allProducts = await db.listProducts();

      const search = query.toLowerCase();

      const filtered = allProducts.filter((p) => {
        const text = [
          p.name,
          p.countryName,
          p.serviceCode,
          p.providerId,
          p.countryId,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return text.includes(search);
      });

      const PAGE_SIZE = 30;

      const pageProducts = filtered.slice(
        0,
        PAGE_SIZE
      );

      const totalPages = Math.max(
        1,
        Math.ceil(filtered.length / PAGE_SIZE)
      );

      if (!filtered.length) {
        await ctx.reply(
          "🔎 <b>Search Result</b>\n\n" +
          `❌ No product found for: <code>${escapeHtml(query)}</code>`,
          {
            parse_mode: "HTML",
            ...productListKeyboard([], 1, 0, query),
          }
        );
        return;
      }

      await ctx.reply(
        "🔎 <b>Search Result</b>\n\n" +
        `📦 Found: <b>${filtered.length}</b>\n` +
        `📄 Page: <b>1/${totalPages}</b>\n` +
        `🔎 Query: <code>${escapeHtml(query)}</code>`,
        {
          parse_mode: "HTML",
          ...productListKeyboard(
            pageProducts,
            1,
            filtered.length,
            query
          ),
        }
      );
    },



    admin_product_auto_usd: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const usd = Number(raw);

      if (!Number.isFinite(usd) || usd <= 0 || usd > 10000) {
        await ctx.reply(
          "❌ Invalid USD price. Example: 0.40",
          cancelKeyboard()
        );
        return;
      }

      const settings = await db.getSettings();

      const usdRate = Number(settings.usdRate || 0);
      const marginPercent = Number(settings.profit || 0);

      if (usdRate <= 0) {
        await ctx.reply(
          "⚠️ USD Rate is not configured.",
          cancelKeyboard()
        );
        return;
      }

      const countries = await db.listServer1Countries({
        onlyEnabled: true,
      });

      if (!countries.length) {
        session.clear(ctx.from.id);
        await ctx.reply(
          "⚠️ No enabled Server 1 countries found.",
          productsMenu()
        );
        return;
      }

      const description =
        "📱 Telegram Account • ⚡ Fast & Reliable";

      let created = 0;
      let skipped = 0;

      for (const country of countries) {
        const countryName =
          country.countryName ||
          country.name ||
          "Unknown Country";

        const emoji = country.emoji || "🌍";

        const productName =
          `${emoji} Telegram ${countryName}`;

        // Prevent duplicate products for the same country/service.
        const existing = await db.listProducts({
          countryId: country.id,
        });

        const duplicate = existing.find(
          (p) =>
            p.serviceCode === "tg" &&
            p.providerId === "grizzly"
        );

        if (duplicate) {
          skipped++;
          continue;
        }

        const costInr = usd * usdRate;

        const finalPrice = costInr + (costInr * marginPercent / 100);

        await db.createProduct({
          name: productName,
          description,
          serviceCode: "tg",

          countryId: country.id,
          providerId: "grizzly",

          priceMode: "API",
          providerUsdPrice: usd,
          usdRate,
          marginPercent,

          apiPrice: finalPrice,
          manualPrice: 0,
          stock: 0,
        });

        created++;
      }

      session.clear(ctx.from.id);

      await ctx.reply(
        `✅ <b>Bulk Generation Complete</b>\n\n` +
        `🌍 Countries: <b>${countries.length}</b>\n` +
        `✅ Created: <b>${created}</b>\n` +
        `⏭️ Already Exists: <b>${skipped}</b>\n\n` +
        `💵 Source Cost: $${usd.toFixed(4)}\n` +
        `💱 USD Rate: ₹${usdRate.toFixed(2)}\n` +
        `📈 Margin: ${marginPercent.toFixed(2)}%`,
        productsMenu()
      );
    },

    admin_product_server1_usd: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const usd = Number(raw);

      if (!Number.isFinite(usd) || usd <= 0 || usd > 10000) {
        await ctx.reply(
          "❌ Invalid USD price. Example: 0.40",
          cancelKeyboard()
        );
        return;
      }

      const settings = await db.getSettings();

      const usdRate = Number(settings.usdRate || 0);
      const marginPercent = Number(settings.profit || 0);

      if (usdRate <= 0) {
        await ctx.reply(
          "⚠️ USD Rate is not configured.\n\n" +
          "Go to Admin → Settings and set the USD Rate first.",
          cancelKeyboard()
        );
        return;
      }

      const costInr = usd * usdRate;
      const finalPrice = costInr + (costInr * marginPercent / 100);

      const productName =
        `${state.data.emoji} Telegram ${state.data.countryName}`;

      const description =
        "📱 Telegram Account • ⚡ Fast & Reliable";

      const product = await db.createProduct({
        name: productName,
        description,
        serviceCode: "tg",

        countryId: state.data.countryId,
        providerId: "grizzly",

        priceMode: "API",
        providerUsdPrice: usd,
        usdRate,
        marginPercent,

        apiPrice: finalPrice,
        manualPrice: 0,
        stock: 0,
      });

      session.clear(ctx.from.id);

      await ctx.reply(
        `✅ <b>Product Created</b>\n\n` +
        `${escapeHtml(product.name)}\n` +
        `🔑 Service: <code>tg</code>\n` +
        `📝 ${escapeHtml(description)}\n\n` +
        `💵 <b>Source Cost:</b> $${usd.toFixed(4)}\n` +
        `💱 USD Rate: ₹${usdRate.toFixed(2)}\n` +
        `📈 Margin: ${marginPercent.toFixed(2)}%\n` +
        `💰 Selling Price: ₹${finalPrice.toFixed(2)}`,
        productsMenu()
      );
    },

    admin_product_add_name: async (ctx, state) => {
      const name = parseText(ctx.message.text, { minLen: 1, maxLen: 80 });
      if (name === null) {
        await ctx.reply("❌ Invalid name.", cancelKeyboard());
        return;
      }

      state.data.name = name;
      state.step = "admin_product_add_pick_country";
      session.set(ctx.from.id, state);

      const countries = await db.listCountries();
      await ctx.reply("Select a country:", countryPickerKeyboard(countries, "admin:products:add:country"));
    },

    admin_product_add_price: async (ctx, state) => {
      const price = parseAmount(ctx.message.text, { min: 0.01 });
      if (price === null) {
        await ctx.reply("❌ Invalid price. Enter a positive number.", cancelKeyboard());
        return;
      }

      state.data.price = price;
      state.step = "admin_product_add_stock";
      session.set(ctx.from.id, state);

      await ctx.reply("Enter the initial stock quantity:", cancelKeyboard());
    },

    admin_product_add_stock: async (ctx, state) => {
      const stock = parseInt0Plus(ctx.message.text);
      if (stock === null) {
        await ctx.reply("❌ Invalid quantity. Enter a whole number (0 or more).", cancelKeyboard());
        return;
      }

      const { name, countryId, providerId, priceMode, price } = state.data;
      const product = await db.createProduct({
        name,
        countryId,
        providerId,
        priceMode,
        apiPrice: priceMode === "API" ? price : 0,
        manualPrice: priceMode === "MANUAL" ? price : 0,
        stock,
      });

      session.clear(ctx.from.id);
      await ctx.reply(
        `✅ Product created: ${escapeHtml(product.name)} — ₹${formatAmount(product.finalPrice)} (${stock} in stock)`,
        productsMenu()
      );
    },

    admin_product_edit_emoji: async (ctx, state) => {
      const emoji = String(ctx.message.text || "").trim();

      if (!emoji || emoji.length > 20) {
        await ctx.reply(
          "❌ Invalid emoji. Please send a valid emoji.",
          cancelKeyboard()
        );
        return;
      }

      await updateProductAndInvalidate(state.data.productId, {
        emoji,
      });


      const product = await db.getProduct(state.data.productId);

      await editAdminMessage(
        ctx,
        `✅ Emoji updated: ${escapeHtml(product.emoji || emoji)}`,
        productDetailKeyboard(product)
      );
      session.clear(ctx.from.id);
    },


    admin_product_edit_description: async (ctx, state) => {
      const description = parseText(ctx.message.text, {
        minLen: 1,
        maxLen: 500,
      });

      if (description === null) {
        await ctx.reply(
          "❌ Invalid description.",
          cancelKeyboard()
        );
        return;
      }

      await updateProductAndInvalidate(state.data.productId, {
        description,
      });


      const product = await db.getProduct(state.data.productId);

      await editAdminMessage(
        ctx,
        `✅ <b>Description updated.</b>\n\n` +
        escapeHtml(product.description || ""),
        {
          parse_mode: "HTML",
          ...productDetailKeyboard(product),
        }
      );
      session.clear(ctx.from.id);
    },


    admin_product_edit_margin: async (ctx, state) => {
      const raw = String(ctx.message.text || "").trim();
      const margin = Number(raw);

      if (
        !Number.isFinite(margin) ||
        margin < 0 ||
        margin > 100
      ) {
        await ctx.reply(
          "❌ Invalid margin.\n\nEnter a percentage between 0 and 100.\nExample: 40",
          cancelKeyboard()
        );
        return;
      }

      const productId = state.data.productId;

      const product = await db.getProduct(productId);

      if (!product) {
          await ctx.reply("❌ Product not found.");
        return;
      }

      await updateProductAndInvalidate(productId, {
        marginPercent: margin,
      });

      session.clear(ctx.from.id);

      const updated = await db.getProduct(productId);

      await editAdminMessage(
        ctx,
        `✅ <b>Profit Margin Updated</b>\n\n` +
        `📈 Margin: <b>${margin.toFixed(2)}%</b>\n` +
        `💰 Selling Price: <b>₹${formatAmount(updated.finalPrice)}</b>`,
        {
          parse_mode: "HTML",
          ...productDetailKeyboard(updated),
        }
      );
      session.clear(ctx.from.id);
    },


    admin_product_edit_service: async (ctx, state) => {
      const serviceCode = parseText(ctx.message.text, {
        minLen: 1,
        maxLen: 50,
      });

      if (serviceCode === null) {
        await ctx.reply(
          "❌ Invalid service code.",
          cancelKeyboard()
        );
        return;
      }

      await updateProductAndInvalidate(state.data.productId, {
        serviceCode,
      });


      const product = await db.getProduct(state.data.productId);

      await editAdminMessage(
        ctx,
        `✅ Service Code updated: <code>${escapeHtml(product.serviceCode)}</code>`,
        {
          parse_mode: "HTML",
          ...productDetailKeyboard(product),
        }
      );
      session.clear(ctx.from.id);
    },


    admin_product_edit_name: async (ctx, state) => {
      const name = parseText(ctx.message.text, { minLen: 1, maxLen: 80 });
      if (name === null) {
        await ctx.reply("❌ Invalid name.", cancelKeyboard());
        return;
      }
      await updateProductAndInvalidate(state.data.productId, { name });

      const product = await db.getProduct(state.data.productId);
      await editAdminMessage(
        ctx,
        `✅ Name updated: ${escapeHtml(product.name)}`,
        productDetailKeyboard(product)
      );
      session.clear(ctx.from.id);
    },

  };

  return { textSteps };
}

module.exports = { registerAdminProductsHandler };
