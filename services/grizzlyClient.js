const https = require("https");

const API_URL =
  process.env.GRIZZLY_API_URL ||
  "https://api.grizzlysms.com/stubs/handler_api.php";

const API_KEY = process.env.GRIZZLY_API_KEY;

function request(params = {}) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      return reject(new Error("GRIZZLY_API_KEY_MISSING"));
    }

    const url = new URL(API_URL);

    url.searchParams.set("api_key", API_KEY);

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "AccountStore-Server1/1.0",
          Accept: "application/json,text/plain,*/*",
        },
      },
      (res) => {
        let body = "";

        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          body += chunk;
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(
                `GRIZZLY_HTTP_${res.statusCode}: ${body.slice(0, 300)}`
              )
            );
          }

          const text = body.trim();

          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      }
    );

    req.setTimeout(30000, () => {
      req.destroy(new Error("GRIZZLY_REQUEST_TIMEOUT"));
    });

    req.on("error", reject);
  });
}

async function getBalance() {
  return request({
    action: "getBalance",
  });
}

async function getPrices() {
  return request({
    action: "getPrices",
  });
}

async function getPricesV2(serviceCode, countryCode) {
  const params = {
    action: "getPricesV2",
  };

  if (serviceCode) {
    params.service = String(serviceCode);
  }

  if (countryCode) {
    params.country = String(countryCode);
  }

  return request(params);
}

async function getServices() {
  return request({
    action: "getServices",
  });
}

async function getCountries() {
  return request({
    action: "getCountries",
  });
}

function findServicePrice(prices, serviceCode, countryCode) {
  const service = String(serviceCode || "").trim();
  const country = String(countryCode || "").trim();

  if (!prices || typeof prices !== "object") {
    return null;
  }

  // Format 1:
  // {
  //   tg: { count, cost, retry }
  // }
  if (prices[service]) {
    const item = prices[service];

    if (Number.isFinite(Number(item.cost))) {
      return {
        provider: "grizzly",
        serviceCode: service,
        countryCode: country,
        costUsd: Number(item.cost),
        count: Number(item.count || 0),
        retry: Number(item.retry || 0),
      };
    }
  }

  // Format 2:
  // {
  //   "22": {
  //     tg: { count, cost, retry }
  //   }
  // }
  if (country && prices[country]?.[service]) {
    const item = prices[country][service];

    if (Number.isFinite(Number(item.cost))) {
      return {
        provider: "grizzly",
        serviceCode: service,
        countryCode: country,
        costUsd: Number(item.cost),
        count: Number(item.count || 0),
        retry: Number(item.retry || 0),
      };
    }
  }

  return null;
}

async function getServicePrice(serviceCode, countryCode) {
  const prices = await getPrices();

  const result = findServicePrice(
    prices,
    serviceCode,
    countryCode
  );

  if (!result) {
    const err = new Error(
      `GRIZZLY_PRICE_NOT_FOUND:${serviceCode}:${countryCode || ""}`
    );

    err.code = "GRIZZLY_PRICE_NOT_FOUND";

    throw err;
  }

  return result;
}


async function getActivationStatus(activationId) {
  if (!activationId) {
    const err = new Error("ACTIVATION_ID_REQUIRED");
    err.code = "ACTIVATION_ID_REQUIRED";
    throw err;
  }

  const result = await request({
    action: "getStatusV2",
    id: String(activationId),
  });

  // Keep the provider response untouched.
  // Grizzly may return OTP in different fields depending on
  // activation/provider state.
  return result;
}

async function cancelActivation(activationId) {
  if (!activationId) {
    const err = new Error("ACTIVATION_ID_REQUIRED");
    err.code = "ACTIVATION_ID_REQUIRED";
    throw err;
  }

  const result = await request({
    action: "setStatus",
    id: String(activationId),
    status: 8,
  });

  // ----------------------------------------------------------
  // IMPORTANT:
  // BAD_ACTION means Grizzly did NOT accept the cancellation.
  // Do NOT treat it as a successful cancel.
  // ----------------------------------------------------------
  const responseText = String(result || "").trim().toUpperCase();

  if (
    responseText === "BAD_ACTION" ||
    responseText === "ACCESS_DENIED" ||
    responseText === "ERROR"
  ) {
    const err = new Error(`GRIZZLY_CANCEL_FAILED: ${result}`);
    err.code = "GRIZZLY_CANCEL_FAILED";
    err.providerResponse = result;
    throw err;
  }

  return result;
}

async function getNumberV2({
  service = "tg",
  country = "",
  maxPrice,
  providerIds,
  exceptProviderIds,
  phoneException,
  minPrice,
} = {}) {
  return request({
    action: "getNumberV2",
    service,
    country,
    maxPrice,
    providerIds,
    exceptProviderIds,
    phoneException,
    minPrice,
  });
}


module.exports = {
  getNumberV2,
  getActivationStatus,
  cancelActivation,
  getBalance,
  getPrices,
  getPricesV2,
  getServicePrice,
  getServices,
  getCountries,
};
