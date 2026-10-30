function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function authorized(request, env, name) {
  const expected = String(env[name] || "");
  return Boolean(expected && String(request.headers.get("authorization") || "") === `Bearer ${expected}`);
}
function validParams(params) {
  return Array.isArray(params) && params.length <= 100 && params.every(v => v === null || ["string","number","boolean"].includes(typeof v));
}
async function digestHex(algorithm, keyBytes, value) {
  const data = new TextEncoder().encode(value);
  let result;
  if (algorithm === "HMAC") {
    const key = await crypto.subtle.importKey("raw", keyBytes, {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
    result = await crypto.subtle.sign("HMAC", key, data);
  } else result = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(result)].map(x => x.toString(16).padStart(2,"0")).join("");
}
async function claimGlobalPayment(body, env) {
  const botId=String(body?.bot_id||"").trim(), depositId=String(body?.deposit_id||"").trim(), userId=String(body?.user_id||"").trim();
  const amountMinor=Number(body?.amount_minor), identifiers=Array.isArray(body?.identifiers)?body.identifiers:[];
  if (!["KAP_SMS","ACCOUNT_STORE"].includes(botId)||!depositId||!userId||!Number.isSafeInteger(amountMinor)||amountMinor<=0||identifiers.length<1||identifiers.length>10)
    return json({ok:false,reason:"INVALID_PAYMENT"},400);
  const secret=String(env.GLOBAL_PAYMENT_SECRET||"");
  if(!secret)return json({ok:false,reason:"GLOBAL_PAYMENT_NOT_CONFIGURED"},503);
  const paymentKey=await digestHex("SHA-256",null,botId+":"+depositId), normalized=[];
  for(const item of identifiers){
    const type=String(item?.type||"").trim().toUpperCase(), value=String(item?.value||"").trim().toUpperCase();
    if(!["UTR","TRANSACTION_ID"].includes(type)||!value||value.length>256)return json({ok:false,reason:"INVALID_IDENTIFIER"},400);
    const hash=await digestHex("HMAC",new TextEncoder().encode(secret),value);
    if(!normalized.some(x=>x.hash===hash))normalized.push({hash,type});
  }
  const oldRows=await env.DB.prepare("SELECT identifier_hash FROM global_payment_identifiers WHERE payment_key=?").bind(paymentKey).all();
  const oldHashes=new Set((oldRows.results||[]).map(x=>x.identifier_hash));
  const now=Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO global_payment_records(payment_key,bot_id,deposit_id,user_id,amount_minor,status,created_at,updated_at) VALUES(?,?,?,?,?,'RESERVED',?,?)").bind(paymentKey,botId,depositId,userId,amountMinor,now,now),
    ...normalized.map(x=>env.DB.prepare("INSERT OR IGNORE INTO global_payment_identifiers(identifier_hash,payment_key,identifier_type,created_at) VALUES(?,?,?,?)").bind(x.hash,paymentKey,x.type,now))
  ]);
  const record=await env.DB.prepare("SELECT bot_id,deposit_id,user_id,amount_minor,status FROM global_payment_records WHERE payment_key=?").bind(paymentKey).first();
  if(!record||record.bot_id!==botId||record.deposit_id!==depositId||record.user_id!==userId||Number(record.amount_minor)!==amountMinor)
    return json({ok:false,reason:"PAYMENT_KEY_CONFLICT"},409);
  if(record.status==="REJECTED")return json({ok:false,reason:"PAYMENT_REJECTED"},409);
  const marks=normalized.map(()=>"?").join(",");
  const rows=await env.DB.prepare("SELECT identifier_hash,payment_key FROM global_payment_identifiers WHERE identifier_hash IN ("+marks+")").bind(...normalized.map(x=>x.hash)).all();
  if((rows.results||[]).some(x=>x.payment_key!==paymentKey)){
    const newHashes=normalized.map(x=>x.hash).filter(h=>!oldHashes.has(h));
    if(newHashes.length){
      const deleteMarks=newHashes.map(()=>"?").join(",");
      await env.DB.prepare("DELETE FROM global_payment_identifiers WHERE payment_key=? AND identifier_hash IN ("+deleteMarks+")").bind(paymentKey,...newHashes).run();
    }
    await env.DB.prepare("UPDATE global_payment_records SET status='REJECTED',updated_at=? WHERE payment_key=? AND status='RESERVED'").bind(Date.now(),paymentKey).run();
    return json({ok:false,reason:"DUPLICATE_PAYMENT"},409);
  }
  return json({ok:true,claimed:true,status:record.status,payment_key:paymentKey});
}
async function abortGlobalPayment(body,env){
  const key=String(body?.payment_key||"").trim();
  if(!/^[a-f0-9]{64}$/.test(key))return json({ok:false,reason:"INVALID_PAYMENT_KEY"},400);
  const row=await env.DB.prepare("SELECT status FROM global_payment_records WHERE payment_key=?").bind(key).first();
  if(!row)return json({ok:true,aborted:true,alreadyAbsent:true});
  if(row.status==="COMMITTED")return json({ok:false,reason:"PAYMENT_ALREADY_COMMITTED"},409);
  if(row.status!=="RESERVED")return json({ok:false,reason:"PAYMENT_NOT_RESERVED"},409);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM global_payment_identifiers WHERE payment_key=? AND payment_key IN (SELECT payment_key FROM global_payment_records WHERE payment_key=? AND status='RESERVED')").bind(key,key),
    env.DB.prepare("DELETE FROM global_payment_records WHERE payment_key=? AND status='RESERVED'").bind(key)
  ]);
  const after=await env.DB.prepare("SELECT status FROM global_payment_records WHERE payment_key=?").bind(key).first();
  if(after)return json({ok:false,reason:"PAYMENT_ABORT_RACE"},409);
  return json({ok:true,aborted:true});
}
async function commitGlobalPayment(body,env){
  const key=String(body?.payment_key||"").trim();
  if(!/^[a-f0-9]{64}$/.test(key))return json({ok:false,reason:"INVALID_PAYMENT_KEY"},400);
  await env.DB.prepare("UPDATE global_payment_records SET status='COMMITTED',updated_at=? WHERE payment_key=? AND status IN ('RESERVED','COMMITTED')").bind(Date.now(),key).run();
  const row=await env.DB.prepare("SELECT status FROM global_payment_records WHERE payment_key=?").bind(key).first();
  if(!row||row.status!=="COMMITTED")return json({ok:false,reason:"PAYMENT_NOT_RESERVED"},409);
  return json({ok:true,committed:true,status:row.status});
}
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(request.method==="GET"&&url.pathname==="/health"){
   try{const row=await env.DB.prepare("SELECT COUNT(*) AS count FROM firestore_documents").first();return json({ok:true,service:"account-store-d1",database:"connected",documents:Number(row?.count||0)});}
   catch(error){return json({ok:false,service:"account-store-d1",database:"error",error:String(error?.message||error)},500);}
  }
  if(request.method!=="POST")return json({error:"Method not allowed"},405);
  if(url.pathname==="/global-payment/claim"||url.pathname==="/global-payment/commit"||url.pathname==="/global-payment/abort"){
   if(!authorized(request,env,"GLOBAL_PAYMENT_SECRET"))return json({ok:false,error:"Unauthorized"},401);
   try{const body=await request.json();if(url.pathname==="/global-payment/claim")return await claimGlobalPayment(body,env);if(url.pathname==="/global-payment/abort")return await abortGlobalPayment(body,env);return await commitGlobalPayment(body,env);}
   catch(error){console.error("[GLOBAL PAYMENT LOCK]",error);return json({ok:false,error:"GLOBAL_PAYMENT_INTERNAL_ERROR"},500);}
  }
  if(!authorized(request,env,"D1_API_SECRET"))return json({error:"Unauthorized"},401);
  try{
   const body=await request.json();
   if(url.pathname==="/query"){
    const sql=String(body?.sql||"").trim(),params=body?.params??[];
    if(!sql)return json({error:"sql is required"},400);
    if(!validParams(params))return json({error:"params must be an array of <=100 scalar values"},400);
    return json(await env.DB.prepare(sql).bind(...params).all());
   }
   if(url.pathname==="/lock/acquire"){
    const holder=String(body?.holder||"").trim(),ttl=Math.max(5000,Math.min(Number(body?.ttlMs)||15000,60000));
    if(!holder)return json({error:"holder is required"},400);
    const now=Date.now();await env.DB.prepare("CREATE TABLE IF NOT EXISTS d1_mutex(id TEXT PRIMARY KEY,holder TEXT NOT NULL,expires_at INTEGER NOT NULL)").run();
    await env.DB.batch([env.DB.prepare("DELETE FROM d1_mutex WHERE id=? AND expires_at<=?").bind("global",now),env.DB.prepare("INSERT OR IGNORE INTO d1_mutex(id,holder,expires_at) VALUES(?,?,?)").bind("global",holder,now+ttl)]);
    const row=await env.DB.prepare("SELECT holder,expires_at FROM d1_mutex WHERE id=?").bind("global").first();
    return json({acquired:Boolean(row&&row.holder===holder),expiresAt:row?.expires_at||null});
   }
   if(url.pathname==="/lock/release"){
    const holder=String(body?.holder||"").trim();if(!holder)return json({error:"holder is required"},400);
    await env.DB.prepare("DELETE FROM d1_mutex WHERE id=? AND holder=?").bind("global",holder).run();return json({released:true});
   }
   if(url.pathname==="/batch"){
    const batch=body?.batch;if(!Array.isArray(batch)||batch.length===0||batch.length>100)return json({error:"batch must contain 1-100 queries"},400);
    const statements=[];for(const item of batch){const sql=String(item?.sql||"").trim(),params=item?.params??[];if(!sql||!validParams(params))return json({error:"Invalid batch query"},400);statements.push(env.DB.prepare(sql).bind(...params));}
    return json({success:true,results:await env.DB.batch(statements)});
   }
   return json({error:"Not found"},404);
  }catch(error){console.error("[D1 API]",error);return json({error:String(error?.message||error)},500);}
 }
};