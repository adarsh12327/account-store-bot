# Firestore -> Cloudflare D1 migration

The bot currently uses Firestore. This migration is deliberately staged:

1. Create the D1 database.
2. Run `migrations/0001_firestore_documents.sql`.
3. Copy Firestore into D1 with `node scripts/migrate-firestore-to-d1.js`.
4. Verify row counts.
5. Deploy the Cloudflare Worker bridge in `cloudflare-d1-api/`.
6. Only after verification, switch the Railway bot database layer to D1.

The Railway bot is **not switched to D1 by this commit**. This avoids a production cutover before the D1 bridge and data verification are complete.

Cloudflare recommends a Worker proxy when an application outside Workers needs to access D1; the built-in D1 REST API is primarily intended for administrative use because it is subject to global Cloudflare API rate limits.
