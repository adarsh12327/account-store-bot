const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { authenticate } = require("@google-cloud/local-auth");

const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const TOKEN_PATH = path.join(process.cwd(), "gmail-token.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
];

let gmailClient = null;

function loadCredentials() {
  if (process.env.GMAIL_CREDENTIALS_JSON) {
    const parsed = JSON.parse(process.env.GMAIL_CREDENTIALS_JSON);
    return parsed.installed || parsed.web || parsed;
  }

  const data = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  return data.installed || data.web;
}

function loadToken() {
  if (process.env.GMAIL_TOKEN_JSON) {
    return JSON.parse(process.env.GMAIL_TOKEN_JSON);
  }

  if (!fs.existsSync(TOKEN_PATH)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(TOKEN_PATH, "utf8")
  );
}

async function getGmailClient() {
  if (gmailClient) {
    return gmailClient;
  }

  let credentials;

  try {
    credentials = loadCredentials();
  } catch (err) {
    throw new Error(
      "Gmail credentials are not configured. Set GMAIL_CREDENTIALS_JSON or provide credentials.json."
    );
  }

  if (!credentials) {
    throw new Error(
      "Invalid Gmail OAuth credentials."
    );
  }

  const { client_id, client_secret, redirect_uris } = credentials;

  if (!client_id || !client_secret) {
    throw new Error(
      "Invalid Gmail OAuth credentials: client_id/client_secret missing."
    );
  }

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://localhost"
  );

  // ----------------------------------------------------------
  // Existing token
  // ----------------------------------------------------------

  const existingToken = loadToken();

  if (existingToken) {
    oauth2Client.setCredentials(existingToken);

    oauth2Client.on("tokens", (tokens) => {
      // Environment-variable deployments cannot persist env changes.
      // The refresh token remains in the configured token, so only
      // persist refreshed access tokens when a writable local file exists.
      if (process.env.GMAIL_TOKEN_JSON) {
        return;
      }

      try {
        const current = fs.existsSync(TOKEN_PATH)
          ? JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"))
          : {};

        const updated = {
          ...current,
          ...tokens,
        };

        fs.writeFileSync(
          TOKEN_PATH,
          JSON.stringify(updated, null, 2),
          { mode: 0o600 }
        );
      } catch (_) {}
    });

    gmailClient = google.gmail({
      version: "v1",
      auth: oauth2Client,
    });

    return gmailClient;
  }

  // ----------------------------------------------------------
  // First-time OAuth
  // ----------------------------------------------------------

  const auth = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });

  const token = auth.credentials;

  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify(token, null, 2),
    { mode: 0o600 }
  );

  gmailClient = google.gmail({
    version: "v1",
    auth,
  });

  return gmailClient;
}

async function testGmail() {
  const gmail = await getGmailClient();

  const result = await gmail.users.messages.list({
    userId: "me",
    maxResults: 5,
  });

  return result.data.messages || [];
}

module.exports = {
  getGmailClient,
  testGmail,
};
