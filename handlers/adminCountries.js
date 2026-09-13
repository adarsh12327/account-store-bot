/**
 * handlers/adminCountries.js
 * ------------------------------------------------------------------
 * 🌍 Country manager (admin only). Data management only.
 *
 * textSteps: admin_country_add_name, admin_country_add_code,
 *            admin_country_add_emoji, admin_country_edit_name
 * ------------------------------------------------------------------
 */

const db = require("../database");
const logger = require("../utils/logger");
const session = require("../utils/session");
const { requireAdmin } = require("./admin");
const { parseText } = require("../utils/validation");
const { escapeHtml } = require("../utils/helpers");
const countryCatalog = require("../services/server1/countryCatalog");
const {
  countriesMenu,
  countryListKeyboard,
  countryDetailKeyboard,
  confirmDeleteCountryKeyboard,
  cancelKeyboard,
} = require("../keyboards/admin");


function registerAdminCountriesHandler(bot) {
  bot.action("admin:countries", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;
      await ctx.editMessageText("🌍 <b>Country Manager</b>", {
  parse_mode: "HTML",
  ...countriesMenu(),
});

    } catch (err) {
      logger.error("Error in admin:countries action", err);
    }
  });
  // ==========================================================
  // SERVER 1 COUNTRIES
  // ==========================================================

  bot.action("admin:countries:server1", async (ctx) => {
    try {
      await ctx.answerCbQuery();

      if (!(await requireAdmin(ctx))) return;

      await ctx.editMessageText(
        "🖥️ <b>Server 1 Countries</b>\n\nSelect an option:",
        {
          parse_mode: "HTML",
          ...require("../keyboards/admin").server1CountriesMenu(),
        }
      );
    } catch (err) {
      logger.error(
        "Error in admin:countries:server1 action",
        err
      );
    }
  });
// ==========================================================
// SERVER 1 — ADD COUNTRY
// ==========================================================

bot.action("admin:countries:server1:add", async (ctx) => {
  try {
    await ctx.answerCbQuery();

    if (!(await requireAdmin(ctx))) return;

    await ctx.editMessageText(
      "🔄 <b>Adding Countries...</b>\n\nPlease wait...",
      { parse_mode: "HTML" }
    );

    const result = await db.syncServer1Countries(
      countryCatalog
    );

    await ctx.editMessageText(
      "✅ <b>Server 1 Countries Saved</b>\n\n" +
      `🌍 Total Countries: <b>${result.total}</b>\n` +
      `💾 Saved/Updated: <b>${result.saved}</b>`,
      {
        parse_mode: "HTML",
        ...require("../keyboards/admin").server1CountriesMenu(),
      }
    );

  } catch (err) {
    logger.error(
      "Error in Server 1 country sync",
      err
    );

    await ctx.editMessageText(
      "❌ <b>Country Sync Failed</b>\n\n" +
      `${escapeHtml(err.message || "Unknown error")}`,
      {
        parse_mode: "HTML",
        ...require("../keyboards/admin").server1CountriesMenu(),
      }
    );
  }
});
// ==========================================================
// SERVER 1 — COUNTRY LIST
// ==========================================================

async function showServer1CountryPage(ctx, page = 1) {
  const countries = await db.listServer1Countries({
    provider: "grizzly",
  });

  const perPage = 20;
  const totalPages = Math.max(
    1,
    Math.ceil(countries.length / perPage)
  );

  page = Math.max(1, Math.min(page, totalPages));

  const start = (page - 1) * perPage;
  const current = countries.slice(start, start + perPage);

  let text =
    `📋 <b>Server 1 Countries</b>\n\n` +
    `🌍 Total: <b>${countries.length}</b>\n` +
    `📄 Page: <b>${page}/${totalPages}</b>\n\n`;

  current.forEach((country, index) => {
    text +=
      `${start + index + 1}. ` +
      `${country.emoji || "🌍"} ` +
      `<b>${escapeHtml(
        country.countryName || country.name || "Unknown"
      )}</b>\n` +
      `   Code: <code>${escapeHtml(
        country.countryCode || "N/A"
      )}</code>\n\n`;
  });

  const buttons = [];

  if (page > 1) {
    buttons.push({
      text: "⬅️ Previous",
      callback_data: `admin:countries:server1:list:${page - 1}`,
    });
  }

  if (page < totalPages) {
    buttons.push({
      text: "Next ➡️",
      callback_data: `admin:countries:server1:list:${page + 1}`,
    });
  }

  const keyboard = [];

  if (buttons.length) {
    keyboard.push(buttons);
  }

  keyboard.push([
    {
      text: "🔎 Search Country",
      callback_data: "admin:countries:server1:search",
    },
  ]);

  keyboard.push([
    {
      text: "⬅️ Server 1 Countries",
      callback_data: "admin:countries:server1",
    },
  ]);

  try {
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
} catch (err) {
  if (
    !String(err.message || "")
      .toLowerCase()
      .includes("message is not modified")
  ) {
    throw err;
  }
}
}



// ==========================================================
// SERVER 1 — SEARCH BUTTON
// ==========================================================

  bot.action(
    "admin:countries:server1:search",
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        session.set(ctx.from.id, {
          step: "admin_server1_country_search",
          data: {},
        });

        await ctx.reply(
          "🔎 <b>Search Server 1 Country</b>\n\n" +
          "Country name या country code भेजें.\n\n" +
          "Example: <code>India</code>\n" +
          "Example: <code>22</code>",
          {
            parse_mode: "HTML",
            ...cancelKeyboard(),
          }
        );

      } catch (err) {
        logger.error(
          "Error in Server 1 country search button",
          err
        );

        await ctx.answerCbQuery(
          "Search unavailable.",
          { show_alert: true }
        ).catch(() => {});
      }
    }
  );


// First page
bot.action(
  "admin:countries:server1:list",
  async (ctx) => {
    try {
      await ctx.answerCbQuery();

      if (!(await requireAdmin(ctx))) return;

      await showServer1CountryPage(ctx, 1);

    } catch (err) {
      logger.error(
        "Error in Server 1 country list",
        err
      );

      await ctx.answerCbQuery(
        "Failed to load countries.",
        { show_alert: true }
      ).catch(() => {});
    }
  }
);


// Next / Previous pages
bot.action(
  /^admin:countries:server1:list:(\d+)$/,
  async (ctx) => {
    try {
      await ctx.answerCbQuery();

      if (!(await requireAdmin(ctx))) return;

      const page = Number(ctx.match[1]);

      await showServer1CountryPage(ctx, page);

    } catch (err) {
      logger.error(
        "Error changing Server 1 country page",
        err
      );

      await ctx.answerCbQuery(
        "Failed to load page.",
        { show_alert: true }
      ).catch(() => {});
    }
  }
);
  bot.action("admin:countries:list", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const countries = await db.listCountries();
      if (countries.length === 0) {
        await ctx.reply("No countries yet. Use ➕ Add Country to create one.", countriesMenu());
        return;
      }

      await ctx.editMessageText("📋 <b>Countries</b>", {
  parse_mode: "HTML",
  ...countryListKeyboard(countries),
});

    } catch (err) {
      logger.error("Error in admin:countries:list action", err);
    }
  });

  bot.action("admin:countries:add", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, { step: "admin_country_add_name", data: {} });
      await ctx.reply("Enter the country name:", cancelKeyboard());
    } catch (err) {
      logger.error("Error in admin:countries:add action", err);
    }
  });

  bot.action(/^admin:countries:view:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const country = await db.getCountry(ctx.match[1]);
      if (!country) {
        await ctx.reply("Country not found.", countriesMenu());
        return;
      }

      const text =
        `🌍 <b>${escapeHtml(country.emoji)} ${escapeHtml(country.name)}</b>\n\n` +
        `Code: ${escapeHtml(country.code || "N/A")}\n` +
        `Status: ${country.status}`;

      await ctx.editMessageText(text, {
  parse_mode: "HTML",
  ...countryDetailKeyboard(country),
});

    } catch (err) {
      logger.error("Error in admin:countries:view action", err);
    }
  });

  bot.action(/^admin:countries:edit:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      session.set(ctx.from.id, { step: "admin_country_edit_name", data: { countryId: ctx.match[1] } });
      await ctx.reply("Enter the new country name:", cancelKeyboard());
    } catch (err) {
      logger.error("Error in admin:countries:edit action", err);
    }
  });

  bot.action(/^admin:countries:enable:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Enabled");
      if (!(await requireAdmin(ctx))) return;
      await db.updateCountry(ctx.match[1], { status: "enabled" });
      const country = await db.getCountry(ctx.match[1]);
      await ctx.editMessageText(
  `🟢 ${escapeHtml(country.name)} enabled.`,
  countryDetailKeyboard(country)
);
    } catch (err) {
      logger.error("Error in admin:countries:enable action", err);
    }
  });

  bot.action(/^admin:countries:disable:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Disabled");
      if (!(await requireAdmin(ctx))) return;
      await db.updateCountry(ctx.match[1], { status: "disabled" });
      const country = await db.getCountry(ctx.match[1]);
     await ctx.editMessageText(
  `🔴 ${escapeHtml(country.name)} disabled.`,
  countryDetailKeyboard(country)
);
    } catch (err) {
      logger.error("Error in admin:countries:disable action", err);
    }
  });

  bot.action(/^admin:countries:delete:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!(await requireAdmin(ctx))) return;

      const countryId = ctx.match[1];
      const productCount = await db.countProductsByCountry(countryId);

      const warning =
        productCount > 0
          ? `⚠️ ${productCount} product(s) depend on this country. Deleting it will orphan them.\n\n`
          : "";

   await ctx.editMessageText(
  `${warning}Are you sure you want to delete this country?`,
  confirmDeleteCountryKeyboard(countryId)
);
    } catch (err) {
      logger.error("Error in admin:countries:delete action", err);
    }
  });

  bot.action(/^admin:countries:delete_confirm:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Deleted");
      if (!(await requireAdmin(ctx))) return;

      await db.deleteCountry(ctx.match[1]);
    await ctx.editMessageText(
  "❌ Country deleted.",
  countriesMenu()
);
    } catch (err) {
      logger.error("Error in admin:countries:delete_confirm action", err);
    }
  });

  const textSteps = {
      admin_server1_country_search: async (ctx, state) => {
      const query = String(ctx.message.text || "")
        .trim()
        .toLowerCase();

      if (!query) {
        await ctx.reply(
          "❌ Please enter a country name or country code.",
          cancelKeyboard()
        );
        return;
      }

      try {
        const countries = await db.listServer1Countries({
          provider: "grizzly",
        });

        const results = countries.filter((country) => {
          const name = String(
            country.countryName || country.name || ""
          ).toLowerCase();

          const code = String(
            country.countryCode || ""
          ).toLowerCase();

          return (
            name.includes(query) ||
            code === query
          );
        });

        if (results.length === 0) {
          await ctx.reply(
            `❌ No country found for: <b>${escapeHtml(query)}</b>\n\n` +
            "Try another country name or code.",
            {
              parse_mode: "HTML",
              ...cancelKeyboard(),
            }
          );
          return;
        }

        session.clear(ctx.from.id);

        const rows = results.slice(0, 20).map((country) => [
          {
            text:
              `${country.emoji || "🌍"} ` +
              `${country.countryName || country.name}` +
              ` (${country.countryCode})`,
            callback_data:
              `admin:countries:server1:view:${country.id}`,
          },
        ]);

        rows.push([
          {
            text: "⬅️ Server 1 Countries",
            callback_data: "admin:countries:server1",
          },
        ]);

        await ctx.reply(
          `🔎 <b>Search Results</b>\n\n` +
          `Found: <b>${results.length}</b>\n\n` +
          "Select a country:",
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: rows,
            },
          }
        );

      } catch (err) {
        logger.error(
          "Error searching Server 1 countries",
          err
        );

        await ctx.reply(
          "❌ Failed to search countries.",
          cancelKeyboard()
        );
      }
    },



    admin_country_add_name: async (ctx, state) => {
      const name = parseText(ctx.message.text, { minLen: 1, maxLen: 60 });
      if (name === null) {
        await ctx.reply("❌ Invalid name. Please enter a valid country name.", cancelKeyboard());
        return;
      }
      state.data.name = name;
      state.step = "admin_country_add_code";
      session.set(ctx.from.id, state);
      await ctx.reply("Enter the country code (e.g. US, IN) or type 'skip':", cancelKeyboard());
    },

    admin_country_add_code: async (ctx, state) => {
      const raw = ctx.message.text.trim();
      state.data.code = raw.toLowerCase() === "skip" ? "" : raw.toUpperCase().slice(0, 5);
      state.step = "admin_country_add_emoji";
      session.set(ctx.from.id, state);
      await ctx.reply("Enter a flag emoji for this country (or type 'skip'):", cancelKeyboard());
    },

    admin_country_add_emoji: async (ctx, state) => {
      const raw = ctx.message.text.trim();
      const emoji = raw.toLowerCase() === "skip" ? "🌍" : raw.slice(0, 8);

      const country = await db.createCountry({ name: state.data.name, code: state.data.code, emoji });
      session.clear(ctx.from.id);

      await ctx.reply(`✅ Country created: ${emoji} ${escapeHtml(country.name)}`, countriesMenu());
    },

    admin_country_edit_name: async (ctx, state) => {
      const name = parseText(ctx.message.text, { minLen: 1, maxLen: 60 });
      if (name === null) {
        await ctx.reply("❌ Invalid name.", cancelKeyboard());
        return;
      }

      await db.updateCountry(state.data.countryId, { name });
      session.clear(ctx.from.id);

      const country = await db.getCountry(state.data.countryId);
      await ctx.reply(`✅ Country updated: ${escapeHtml(country.name)}`, countryDetailKeyboard(country));
    },
  };


// ==========================================================
// SERVER 1 — COUNTRY DETAIL
// ==========================================================

bot.action(
  /^admin:countries:server1:view:(.+)$/,
  async (ctx) => {
    try {
      await ctx.answerCbQuery();

      if (!(await requireAdmin(ctx))) return;

      const countryId = ctx.match[1];

      const country = await db.getServer1Country(countryId);

      if (!country) {
        await ctx.editMessageText(
          "❌ <b>Country Not Found</b>",
          {
            parse_mode: "HTML",
            ...require("../keyboards/admin").server1CountriesMenu(),
          }
        );
        return;
      }

      const text =
        `🌍 <b>${escapeHtml(country.emoji || "🌍")} ` +
        `${escapeHtml(country.countryName || country.name || "Unknown")}</b>\n\n` +
        `🔢 Country Code: <code>${escapeHtml(country.countryCode || "N/A")}</code>\n` +
        `🔌 Provider: <b>Configured</b>\n` +
        `📌 Status: <b>${escapeHtml(country.status || "enabled")}</b>`;

      const toggleText =
        (country.status || "enabled") === "enabled"
          ? "🔴 Disable"
          : "🟢 Enable";

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: toggleText,
                callback_data:
                  `admin:countries:server1:toggle:${countryId}`,
              },
              {
                text: "❌ Delete",
                callback_data:
                  `admin:countries:server1:delete:${countryId}`,
              },
            ],
            [
              {
                text: "📋 Country List",
                callback_data:
                  "admin:countries:server1:list",
              },
            ],
            [
              {
                text: "⬅️ Server 1 Countries",
                callback_data:
                  "admin:countries:server1",
              },
            ],
          ],
        },
      });

    } catch (err) {
      logger.error(
        "Error in Server 1 country detail",
        err
      );

      await ctx.answerCbQuery(
        "Failed to load country.",
        { show_alert: true }
      ).catch(() => {});
    }
  }
);


// ==========================================================
// SERVER 1 — COUNTRY ENABLE / DISABLE
// ==========================================================

  bot.action(
    /^admin:countries:server1:toggle:(.+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const countryId = ctx.match[1];
        const country = await db.getServer1Country(countryId);

        if (!country) {
          await ctx.editMessageText(
            "❌ Country not found.",
            require("../keyboards/admin").server1CountriesMenu()
          );
          return;
        }

        const newStatus =
          country.status === "enabled"
            ? "disabled"
            : "enabled";

        const updated = await db.updateServer1Country(
          countryId,
          { status: newStatus }
        );

        const name =
          updated.countryName ||
          updated.name ||
          "Country";

        await ctx.editMessageText(
          `${newStatus === "enabled" ? "🟢" : "🔴"} ` +
          `<b>${escapeHtml(name)}</b> is now ` +
          `<b>${newStatus}</b>.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      newStatus === "enabled"
                        ? "🔴 Disable"
                        : "🟢 Enable",
                    callback_data:
                      `admin:countries:server1:toggle:${countryId}`,
                  },
                ],
                [
                  {
                    text: "❌ Delete",
                    callback_data:
                      `admin:countries:server1:delete:${countryId}`,
                  },
                ],
                [
                  {
                    text: "⬅️ Country List",
                    callback_data:
                      "admin:countries:server1:list",
                  },
                ],
              ],
            },
          }
        );

      } catch (err) {
        logger.error(
          "Error toggling Server 1 country",
          err
        );

        await ctx.answerCbQuery(
          "Failed to update country.",
          { show_alert: true }
        ).catch(() => {});
      }
    }
  );


// ==========================================================
// SERVER 1 — DELETE COUNTRY
// ==========================================================

  bot.action(
    /^admin:countries:server1:delete:(.+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const countryId = ctx.match[1];
        const country = await db.getServer1Country(countryId);

        if (!country) {
          await ctx.editMessageText(
            "❌ Country not found.",
            require("../keyboards/admin").server1CountriesMenu()
          );
          return;
        }

        await ctx.editMessageText(
          `⚠️ <b>Delete Country?</b>\n\n` +
          `${escapeHtml(country.emoji || "🌍")} ` +
          `<b>${escapeHtml(
            country.countryName || country.name || "Unknown"
          )}</b>\n\n` +
          `Code: <code>${escapeHtml(
            country.countryCode || "N/A"
          )}</code>\n\n` +
          `This action cannot be undone.`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "⚠️ Confirm Delete",
                    callback_data:
                      `admin:countries:server1:delete_confirm:${countryId}`,
                  },
                ],
                [
                  {
                    text: "❌ Cancel",
                    callback_data:
                      `admin:countries:server1:view:${countryId}`,
                  },
                ],
              ],
            },
          }
        );

      } catch (err) {
        logger.error(
          "Error preparing Server 1 country deletion",
          err
        );
      }
    }
  );


// ==========================================================
// SERVER 1 — CONFIRM DELETE
// ==========================================================

  bot.action(
    /^admin:countries:server1:delete_confirm:(.+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery();

        if (!(await requireAdmin(ctx))) return;

        const countryId = ctx.match[1];

        await db.deleteServer1Country(countryId);

        await ctx.editMessageText(
          "✅ <b>Country deleted successfully.</b>",
          {
            parse_mode: "HTML",
            ...require("../keyboards/admin").server1CountriesMenu(),
          }
        );

      } catch (err) {
        logger.error(
          "Error deleting Server 1 country",
          err
        );

        await ctx.answerCbQuery(
          "Failed to delete country.",
          { show_alert: true }
        ).catch(() => {});
      }
    }
  );


  return { textSteps };
}


module.exports = { registerAdminCountriesHandler };
