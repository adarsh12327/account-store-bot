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
  const data = JSON.parse(
    fs.readFileSync(CREDENTIALS_PATH, "utf8")
  );

  return data.installed || data.web;
}

async function getGmailClient() {
  if (gmailClient) {
    return gmailClient;
  }

  const credentials = loadCredentials();

  if (!credentials) {
    throw new Error(
      "Invalid credentials.json: installed/web OAuth config not found."
    );
  }

  const { client_id, client_secret, redirect_uris } = credentials;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || "http://localhost"
  );

  // ----------------------------------------------------------
  // Existing token
  // ----------------------------------------------------------

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(
      fs.readFileSync(TOKEN_PATH, "utf8")
    );

    oauth2Client.setCredentials(token);

    // Force Google library to refresh the access token
    // when required.
    oauth2Client.on("tokens", (tokens) => {
      const current = JSON.parse(
        fs.readFileSync(TOKEN_PATH, "utf8")
      );

      const updated = {
        ...current,
        ...tokens,
      };

      fs.writeFileSync(
        TOKEN_PATH,
        JSON.stringify(updated, null, 2),
        { mode: 0o600 }
      );
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
