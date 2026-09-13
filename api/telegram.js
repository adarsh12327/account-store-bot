require("dotenv").config();

const crypto = require("crypto");
const { bot } = require("../bot");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!secret) {
    console.error("Telegram webhook secret is not configured");

    return res.status(500).json({
      ok: false,
    });
  }

  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"];

  if (
    typeof receivedSecret !== "string" ||
    receivedSecret.length !== secret.length ||
    !crypto.timingSafeEqual(
      Buffer.from(receivedSecret),
      Buffer.from(secret)
    )
  ) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  try {
    await bot.handleUpdate(req.body);

    return res.status(200).json({
      ok: true,
    });
  } catch (err) {
    console.error("Telegram webhook error:", err);

    return res.status(500).json({
      ok: false,
    });
  }
};
