"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
globalThis.crypto ||= webcrypto;

const worker = require("../cloudflare/account-store-d1-api.mjs").default;

function makeDb() {
  const records = new Map();
  const aliases = new Map();
  function statement(sql, params = []) {
    return {
      bind(...values) { return statement(sql, values); },
      async run() {
        if (sql.startsWith("INSERT OR IGNORE INTO global_payment_records")) {
          const [key, bot, deposit, user, amount, created, updated] = params;
          if (!records.has(key)) records.set(key, { payment_key:key, bot_id:bot, deposit_id:deposit, user_id:user, amount_minor:amount, status:"RESERVED", created_at:created, updated_at:updated });
          return { meta:{changes:1} };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO global_payment_identifiers")) {
          const [hash, key, type, created] = params;
          if (!aliases.has(hash)) aliases.set(hash,{identifier_hash:hash,payment_key:key,identifier_type:type,created_at:created});
          return { meta:{changes:1} };
        }
        if (sql.startsWith("DELETE FROM global_payment_identifiers")) {
          const [key, ...hashes] = params;
          for (const hash of hashes) if (aliases.get(hash)?.payment_key === key) aliases.delete(hash);
          return { meta:{changes:1} };
        }
        if (sql.startsWith("UPDATE global_payment_records SET status='REJECTED'")) {
          const [updated,key] = params; const row=records.get(key);
          if(row&&row.status==="RESERVED"){row.status="REJECTED";row.updated_at=updated;}
          return {meta:{changes:1}};
        }
        if (sql.startsWith("UPDATE global_payment_records SET status='COMMITTED'")) {
          const [updated,key] = params; const row=records.get(key);
          if(row&&(row.status==="RESERVED"||row.status==="COMMITTED")){row.status="COMMITTED";row.updated_at=updated;}
          return {meta:{changes:1}};
        }
        throw new Error("Unhandled SQL run: "+sql);
      },
      async first() {
        if (sql.includes("FROM global_payment_records WHERE payment_key")) {
          const row=records.get(params[0]); return row ? {...row} : null;
        }
        throw new Error("Unhandled SQL first: "+sql);
      },
      async all() {
        if (sql.includes("FROM global_payment_identifiers WHERE payment_key")) {
          return {results:[...aliases.values()].filter(x=>x.payment_key===params[0]).map(x=>({...x}))};
        }
        if (sql.includes("FROM global_payment_identifiers WHERE identifier_hash IN")) {
          const hashes=new Set(params);return {results:[...aliases.values()].filter(x=>hashes.has(x.identifier_hash)).map(x=>({...x}))};
        }
        throw new Error("Unhandled SQL all: "+sql);
      }
    };
  }
  return {
    prepare(sql){return statement(sql);},
    async batch(items){for(const item of items)await item.run();return items.map(()=>({success:true}));},
    records,aliases
  };
}
function env() { return { GLOBAL_PAYMENT_SECRET:"test-secret", D1_API_SECRET:"legacy-secret", DB:makeDb() }; }
function request(path, body, token="test-secret") {
  return new Request("https://worker.test"+path,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+token},body:JSON.stringify(body)});
}
const payment=(bot,deposit,user,ids)=>({bot_id:bot,deposit_id:deposit,user_id:user,amount_minor:2500,identifiers:ids});

test("same identifier is rejected across bots even when UTR and Transaction ID labels differ",async()=>{
 const e=env();
 const first=await worker.fetch(request("/global-payment/claim",payment("KAP_SMS","d-1","u-1",[{type:"UTR",value:"same-ref"}])),e);
 assert.equal(first.status,200);
 const second=await worker.fetch(request("/global-payment/claim",payment("ACCOUNT_STORE","d-2","u-2",[{type:"TRANSACTION_ID",value:"SAME-REF"}])),e);
 assert.equal(second.status,409);
 assert.equal((await second.json()).reason,"DUPLICATE_PAYMENT");
 assert.equal(e.DB.aliases.size,1);
});

test("failed multi-identifier claim cleans up its newly inserted aliases",async()=>{
 const e=env();
 await worker.fetch(request("/global-payment/claim",payment("KAP_SMS","d-1","u-1",[{type:"UTR",value:"taken-ref"}])),e);
 const result=await worker.fetch(request("/global-payment/claim",payment("ACCOUNT_STORE","d-2","u-2",[
  {type:"UTR",value:"fresh-ref"},{type:"TRANSACTION_ID",value:"taken-ref"}
 ])),e);
 assert.equal(result.status,409);
 assert.equal(e.DB.aliases.size,1);
});

test("claim and commit are idempotent for the same deposit",async()=>{
 const e=env(), body=payment("ACCOUNT_STORE","deposit-7","user-7",[{type:"UTR",value:"utr-7"},{type:"TRANSACTION_ID",value:"tx-7"}]);
 const a=await worker.fetch(request("/global-payment/claim",body),e);
 const b=await worker.fetch(request("/global-payment/claim",body),e);
 assert.equal(a.status,200);assert.equal(b.status,200);
 const key=(await a.json()).payment_key;
 const commitBody={payment_key:key};
 assert.equal((await worker.fetch(request("/global-payment/commit",commitBody),e)).status,200);
 assert.equal((await worker.fetch(request("/global-payment/commit",commitBody),e)).status,200);
 assert.equal(e.DB.records.get(key).status,"COMMITTED");
});

test("global payment endpoints reject missing credentials",async()=>{
 const e=env();
 const response=await worker.fetch(request("/global-payment/claim",{}, "wrong-secret"),e);
 assert.equal(response.status,401);
});
