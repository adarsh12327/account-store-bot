-- Cloudflare D1 schema for the Account Store bot.
-- Firestore documents are preserved as JSON so the migration is lossless.
-- The application can later add generated/indexed columns without changing
-- the stored document format.

CREATE TABLE IF NOT EXISTS firestore_documents (
  collection TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (collection, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_fs_collection
  ON firestore_documents(collection);

CREATE INDEX IF NOT EXISTS idx_fs_collection_created
  ON firestore_documents(collection, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fs_collection_updated
  ON firestore_documents(collection, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_fs_users_telegram_id
  ON firestore_documents(collection, json_extract(data, '$.telegramId'))
  WHERE collection = 'users';

CREATE INDEX IF NOT EXISTS idx_fs_users_referrer
  ON firestore_documents(collection, json_extract(data, '$.referrerId'))
  WHERE collection = 'users';

CREATE INDEX IF NOT EXISTS idx_fs_deposits_status
  ON firestore_documents(collection, json_extract(data, '$.status'))
  WHERE collection = 'deposits';

CREATE INDEX IF NOT EXISTS idx_fs_deposits_utr
  ON firestore_documents(collection, json_extract(data, '$.utr'))
  WHERE collection = 'deposits';

CREATE INDEX IF NOT EXISTS idx_fs_orders_user
  ON firestore_documents(collection, json_extract(data, '$.userId'))
  WHERE collection IN ('orders', 'server1_orders');

CREATE INDEX IF NOT EXISTS idx_fs_orders_status
  ON firestore_documents(collection, json_extract(data, '$.status'))
  WHERE collection IN ('orders', 'server1_orders');

CREATE INDEX IF NOT EXISTS idx_fs_products_country
  ON firestore_documents(collection, json_extract(data, '$.countryId'))
  WHERE collection = 'products';

CREATE INDEX IF NOT EXISTS idx_fs_products_status_service
  ON firestore_documents(
    collection,
    json_extract(data, '$.status'),
    json_extract(data, '$.serviceCode')
  )
  WHERE collection = 'products';

CREATE INDEX IF NOT EXISTS idx_fs_transactions_user
  ON firestore_documents(collection, json_extract(data, '$.userId'))
  WHERE collection = 'transactions';

CREATE INDEX IF NOT EXISTS idx_fs_transactions_type
  ON firestore_documents(collection, json_extract(data, '$.type'))
  WHERE collection = 'transactions';

CREATE INDEX IF NOT EXISTS idx_fs_server1_country_provider
  ON firestore_documents(
    collection,
    json_extract(data, '$.provider'),
    json_extract(data, '$.status')
  )
  WHERE collection = 'server1_countries';

CREATE INDEX IF NOT EXISTS idx_fs_server1_services_country
  ON firestore_documents(collection, json_extract(data, '$.countryId'))
  WHERE collection = 'server1_services';
