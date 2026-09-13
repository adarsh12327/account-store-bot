const grizzly = require("../grizzlyClient");
const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(
  process.cwd(),
  ".cache",
  "server1-grizzly-prices.json"
);

const CACHE_TTL = 60 * 1000;
const API_TIMEOUT = 12000;

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return null;
    }

    const data = JSON.parse(
      fs.readFileSync(CACHE_FILE, "utf8")
    );

    if (!data || !data.prices) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function writeCache(prices) {
  try {
    const dir = path.dirname(CACHE_FILE);

    fs.mkdirSync(dir, {
      recursive: true,
    });

    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify(
        {
          updatedAt: Date.now(),
          prices,
        },
        null,
        2
      )
    );
  } catch {}
}

async function getPricesCached() {
  const cached = readCache();

  if (
    cached &&
    Date.now() - Number(cached.updatedAt || 0) < CACHE_TTL
  ) {
    return cached.prices;
  }

  try {
    const prices = await Promise.race([
      grizzly.getPrices(),

      new Promise((_, reject) => {
        setTimeout(
          () => reject(
            new Error("GRIZZLY_PRICE_TIMEOUT")
          ),
          API_TIMEOUT
        );
      }),
    ]);

    if (!prices || typeof prices !== "object") {
      throw new Error(
        "INVALID_GRIZZLY_PRICE_RESPONSE"
      );
    }

    writeCache(prices);

    return prices;
  } catch (err) {
    if (cached?.prices) {
      console.warn(
        "[SERVER1] Using cached Grizzly prices"
      );

      return cached.prices;
    }

    throw err;
  }
}

class ProviderAdapter {
  constructor(options = {}) {
    this.name = options.name || "Server 1";
    this.enabled = options.enabled !== false;
  }

  _checkEnabled() {
    if (!this.enabled) {
      const err = new Error(
        "SERVER1_DISABLED"
      );

      err.code = "SERVER1_DISABLED";

      throw err;
    }
  }

  async getTelegramPrice(countryCode) {
    this._checkEnabled();

    if (!countryCode) {
      const err = new Error(
        "COUNTRY_CODE_REQUIRED"
      );

      err.code = "COUNTRY_CODE_REQUIRED";

      throw err;
    }

    const prices = await getPricesCached();

    const country = String(countryCode);

    // Handles:
    // prices[country].tg
    if (prices[country]?.tg) {
      const item = prices[country].tg;

      const cost = Number(item.cost);

      if (Number.isFinite(cost) && cost > 0) {
        return {
          provider: "grizzly",
          serviceCode: "tg",
          countryCode: country,
          costUsd: cost,
          count: Number(item.count || 0),
          retry: Number(item.retry || 0),
        };
      }
    }

    // Current response seen in your terminal:
    // prices.tg = { count, cost, retry }
    if (prices.tg) {
      const item = prices.tg;

      const cost = Number(item.cost);

      if (Number.isFinite(cost) && cost > 0) {
        return {
          provider: "grizzly",
          serviceCode: "tg",
          countryCode: country,
          costUsd: cost,
          count: Number(item.count || 0),
          retry: Number(item.retry || 0),
        };
      }
    }

    const err = new Error(
      `TELEGRAM_PRICE_NOT_FOUND:${country}`
    );

    err.code = "TELEGRAM_PRICE_NOT_FOUND";

    throw err;
  }

  async getTelegramPrices(countryCodes = []) {
    this._checkEnabled();

    const prices = await getPricesCached();
    const result = {};

    // Country based response
    for (const code of countryCodes) {
      const countryCode = String(code);
      const item = prices[countryCode]?.tg;

      if (!item) continue;

      const cost = Number(item.cost);

      if (!Number.isFinite(cost) || cost <= 0) {
        continue;
      }

      result[countryCode] = {
        provider: "grizzly",
        serviceCode: "tg",
        countryCode,
        costUsd: cost,
        count: Number(item.count || 0),
        retry: Number(item.retry || 0),
      };
    }

    // Service based response
    if (
      Object.keys(result).length === 0 &&
      prices.tg
    ) {
      const item = prices.tg;
      const cost = Number(item.cost);

      if (Number.isFinite(cost) && cost > 0) {
        result.default = {
          provider: "grizzly",
          serviceCode: "tg",
          countryCode: "any",
          costUsd: cost,
          count: Number(item.count || 0),
          retry: Number(item.retry || 0),
        };
      }
    }

    return result;
  }

  async getAvailability() {
    this._checkEnabled();

    const prices = await getPricesCached();

    const countries = Object.keys(prices).filter(
      (code) =>
        prices[code] &&
        typeof prices[code] === "object" &&
        prices[code].tg
    );

    return {
      provider: "grizzly",
      mode: "live",
      service: "tg",
      countries,
    };
  }

  // Live Grizzly activation.
  async createActivation({
    service = "tg",
    country = "",
    maxPrice,
    providerIds,
    exceptProviderIds,
    phoneException,
    minPrice,
  } = {}) {
    this._checkEnabled();

    const result = await grizzly.getNumberV2({
      service,
      country,
      maxPrice,
      providerIds,
      exceptProviderIds,
      phoneException,
      minPrice,
    });

    if (!result || typeof result !== "object") {
      const err = new Error("INVALID_GRIZZLY_ACTIVATION_RESPONSE");
      err.code = "INVALID_GRIZZLY_ACTIVATION_RESPONSE";
      throw err;
    }

    return {
      provider: "grizzly",
      activationId: result.activationId,
      phoneNumber: result.phoneNumber,
      countryCode: result.countryCode,
      activationCost: Number(result.activationCost || 0),
      activationTime: result.activationTime || null,
      activationCancel: result.activationCancel || null,
      activationEnd: result.activationEnd || null,
      canGetAnotherSms: result.canGetAnotherSms || "0",
      raw: result,
    };
  }

  async getActivationStatus(activationId) {
    this._checkEnabled();

    if (!activationId) {
      const err = new Error("ACTIVATION_ID_REQUIRED");
      err.code = "ACTIVATION_ID_REQUIRED";
      throw err;
    }

    const result =
      await grizzly.getActivationStatus(
        activationId
      );

    if (
      result === undefined ||
      result === null
    ) {
      const err = new Error(
        "INVALID_GRIZZLY_STATUS_RESPONSE"
      );
      err.code =
        "INVALID_GRIZZLY_STATUS_RESPONSE";
      throw err;
    }

    return {
      provider: "grizzly",
      activationId: String(activationId),
      raw: result,
    };
  }

  async cancelActivation(activationId) {
    this._checkEnabled();

    if (!activationId) {
      const err = new Error("ACTIVATION_ID_REQUIRED");
      err.code = "ACTIVATION_ID_REQUIRED";
      throw err;
    }

    const result = await grizzly.cancelActivation(
      activationId
    );

    return {
      provider: "grizzly",
      activationId: String(activationId),
      raw: result,
    };
  }
}

module.exports = ProviderAdapter;
