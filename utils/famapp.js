const FAMAPP_SENDER = "no-reply@famapp.in";

function parseFamAppEmail({ from, subject, body }) {
  if (!from || !body) return null;

  if (!from.toLowerCase().includes(FAMAPP_SENDER)) {
    return null;
  }

  if (!/you received/i.test(subject || "")) {
    return null;
  }

  const amountMatch = body.match(
    /successfully received\s+₹\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const transactionMatch = body.match(
    /transaction\s*id\s*:?\s*([A-Z0-9_-]+)/i
  );

  const utrMatch = body.match(
    /\bUTR\s*:?\s*([A-Z0-9]+)/i
  );

  // Amount जरूरी है.
  // UTR या Transaction ID में से कम-से-कम एक जरूरी है.
  if (!amountMatch || (!transactionMatch && !utrMatch)) {
    return null;
  }

  const amount = Number(
    amountMatch[1].replace(/,/g, "")
  );

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return {
    amount,
    transactionId: transactionMatch
      ? transactionMatch[1].trim().toUpperCase()
      : "",
    utr: utrMatch
      ? utrMatch[1].trim().toUpperCase()
      : "",
    sender: FAMAPP_SENDER,
  };
}

module.exports = {
  parseFamAppEmail,
};
