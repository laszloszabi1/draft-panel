// Zsolt draft-behúzó dashboard — valós adat generátor.
//
// • MINDIG az AKTUÁLIS hónapot mutatja (Európa/Bukarest szerint) → elsején magától nullázódik.
// • A lezárt hónapok titkosított pillanatképe az `archiv/YYYY-MM.json`-ba kerül (a repó publikus,
//   ezért ott is AES-GCM + PIN — nyers ügyféladat SOHA nem kerül olvashatóan a repóba).
// • Az archívum a dashboardon hónap-váltóval nézhető, és CSV-ben exportálható.
// • Futár: DPD ÉS Cargus (2026 augusztusától minden csomag DPD — a Cargus-only ág 0-t mutatna).
//
// Futtatás: node generate.mjs  → kiírja index.html-t a valós számokkal.
// Creds: env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DPD_USERNAME / DPD_PASSWORD)
//        VAGY ~/Desktop/Claude Code Test/mystore-hq/.env.local (local dev).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto as wc, createHash } from 'node:crypto';
const __dir = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = join(__dir, 'archiv');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// AES-GCM titkosítás PIN-nel (a nyers számok SOHA nem kerülnek a publikus HTML-be)
const PIN = process.env.DASHBOARD_PIN || '1234';
async function deriveKey(pin, salt, usage){
  const km = await wc.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return wc.subtle.deriveKey({name:'PBKDF2',salt,iterations:200000,hash:'SHA-256'}, km, {name:'AES-GCM',length:256}, false, [usage]);
}
async function encryptData(plain, pin){
  const salt = wc.getRandomValues(new Uint8Array(16));
  const iv = wc.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, 'encrypt');
  const ct = await wc.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode(plain));
  const b64 = b => Buffer.from(b).toString('base64');
  return { s:b64(salt), i:b64(iv), c:Buffer.from(ct).toString('base64') };
}
async function decryptData(payload, pin){
  const dec = s => Buffer.from(s, 'base64');
  const key = await deriveKey(pin, dec(payload.s), 'decrypt');
  const pt = await wc.subtle.decrypt({name:'AES-GCM',iv:dec(payload.i)}, key, dec(payload.c));
  return JSON.parse(Buffer.from(pt).toString('utf8'));
}
const sha = s => createHash('sha256').update(s).digest('hex').slice(0,16);

// ---- config ----
const FIX = 1000, PER_DELIVERED = 10;                   // 1000 fix + 10 lej/leszállított
const REFRESH_PREV_DAYS = 10;   // a lezárt hónapot még ennyi napig frissítjük (késve beérő csomagok)

// ---- creds ----
let SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
let DPD_USER = process.env.DPD_USERNAME, DPD_PASS = process.env.DPD_PASSWORD;
if (!SB_URL || !SB_KEY || !DPD_USER || !DPD_PASS) {
  const p = homedir()+'/Desktop/Claude Code Test/mystore-hq/.env.local';
  if (existsSync(p)) {
    const env = Object.fromEntries(readFileSync(p,'utf8')
      .split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
    SB_URL ||= env.NEXT_PUBLIC_SUPABASE_URL; SB_KEY ||= env.SUPABASE_SERVICE_ROLE_KEY;
    DPD_USER ||= env.DPD_USERNAME; DPD_PASS ||= env.DPD_PASSWORD;
  }
}
const sb = p => fetch(`${SB_URL}/rest/v1/${p}`,{headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`}}).then(r=>r.json());
const buDay = iso => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));

// ---- hónap-kezelés (a dashboard MINDIG az aktuális hónapot mutatja) ----
const HU_MONTHS = ['Január','Február','Március','Április','Május','Június','Július','Augusztus','Szeptember','Október','November','December'];
const monthLabel = m => `${HU_MONTHS[+m.slice(5,7)-1]} ${m.slice(0,4)}`;
const prevMonth = m => { const [y,mo]=m.split('-').map(Number); const d=new Date(Date.UTC(y, mo-1, 1)); d.setUTCMonth(d.getUTCMonth()-1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; };
const TODAY = buDay(new Date().toISOString());
const CUR   = process.env.DASH_MONTH || TODAY.slice(0,7);
const PREV  = prevMonth(CUR);
const DAY_OF_MONTH = +TODAY.slice(8,10);

// A lezárt hónapot akkor számoljuk újra, ha még nincs archívuma, vagy még friss a hónapforduló.
if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
const prevArchivePath = join(ARCHIVE_DIR, `${PREV}.json`);
let prevReadable = false;
if (existsSync(prevArchivePath)) {
  try { await decryptData(JSON.parse(readFileSync(prevArchivePath,'utf8')), PIN); prevReadable = true; }
  catch { console.error(`⚠️  ${PREV} archívuma nem nyílik a mostani PIN-nel → újraszámoljuk.`); }
}
const needPrev = !prevReadable || DAY_OF_MONTH <= REFRESH_PREV_DAYS;
const MONTHS = needPrev ? [CUR, PREV] : [CUR];
console.log(`Hónapok: aktuális ${CUR}${needPrev?` + lezárt ${PREV} (archívum frissítés)`:''}`);

// ---- Shopify token ----
const shop = (await sb('shops?select=name,domain,access_token,shopify_client_id,shopify_client_secret')).find(s=>s.name==='ReduceriMania.ro');
const base = `https://${shop.domain}/admin/api/2025-10`;
async function shopToken(){
  const p = await fetch(`${base}/shop.json`,{headers:{'X-Shopify-Access-Token':shop.access_token}});
  if (p.ok) return shop.access_token;
  const r = await fetch(`https://${shop.domain}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({grant_type:'client_credentials',client_id:shop.shopify_client_id,client_secret:shop.shopify_client_secret})});
  return (await r.json()).access_token;
}
const H = {'X-Shopify-Access-Token': await shopToken()};

// ---- draft orders (paginated) ----
let url = `${base}/draft_orders.json?limit=250`, drafts = [];
while (url){ const r = await fetch(url,{headers:H}); const j = await r.json(); drafts.push(...(j.draft_orders||[]));
  const m = (r.headers.get('link')||'').match(/<([^>]+)>;\s*rel="next"/); url = m?m[1]:null; }
console.log('draft letöltve:', drafts.length);

const isAband = d => (d.tags||'').toLowerCase().includes('easysell-abandoned-checkout');
// „Felkeresve" = ÉRDEMI jegyzet. A puszta vessző/pont jelölés NEM számít felkeresésnek
// (2026-08: 57 ilyen draft, ebből 49 Perdea) — az külön kategória.
const hasNote = d => !!(d.note && d.note.trim());
const hasRealNote = d => (d.note||'').replace(/[^\p{L}\p{N}]/gu,'').length > 0;
const isPulled = d => d.status==='completed' && d.order_id;
const isCalled = d => isPulled(d) || hasRealNote(d);
const popOf = m => drafts.filter(d => isAband(d) && buDay(d.created_at).slice(0,7)===m);

// ---- behúzott draftok -> Shopify order (mindegyik érintett hónapra) ----
const pulledDrafts = MONTHS.flatMap(m => popOf(m).filter(isPulled));
const ids = [...new Set(pulledDrafts.map(d=>String(d.order_id)))];
const orders = {};
for (let i=0;i<ids.length;i+=250){ const chunk = ids.slice(i,i+250);
  const r = await fetch(`${base}/orders.json?ids=${chunk.join(',')}&status=any&limit=250&fields=id,cancelled_at,fulfillments,note`,{headers:H});
  (await r.json()).orders?.forEach(o=>orders[o.id]=o); }
console.log('order lekérve:', Object.keys(orders).length);

// AWB + futár (a tracking_company dönt: DPD vs Cargus)
const shipOf = {};   // order_id -> {awb, carrier}
pulledDrafts.forEach(d=>{ const o = orders[d.order_id]; if(!o||o.cancelled_at) return;
  const f = (o.fulfillments||[]).filter(x=>x.status!=='cancelled').find(x=>x.tracking_number);
  if(f) shipOf[d.order_id] = { awb:String(f.tracking_number), carrier:/dpd/i.test(f.tracking_company||'') ? 'DPD' : 'Cargus' }; });
const dpdAwbs = [...new Set(Object.values(shipOf).filter(s=>s.carrier==='DPD').map(s=>s.awb))];
const cgAwbs  = [...new Set(Object.values(shipOf).filter(s=>s.carrier==='Cargus').map(s=>s.awb))];
console.log('AWB — DPD:', dpdAwbs.length, '| Cargus:', cgAwbs.length);

// ---- futár-státusz: DPD (/track) ----
const status = {};   // awb -> 'delivered' | 'retur' | 'transit'
// -14 = kézbesítve · 111/124 = végleges retúr · minden más = úton
const dpdClass = code => { const c = String(code); return c==='-14' ? 'delivered' : (c==='111'||c==='124') ? 'retur' : 'transit'; };
if (dpdAwbs.length){
  if (!DPD_USER || !DPD_PASS) console.error('⚠️  Nincs DPD_USERNAME/DPD_PASSWORD — a DPD csomagok „úton" maradnak!');
  else for (let i=0;i<dpdAwbs.length;i+=10){
    const c = dpdAwbs.slice(i,i+10);
    let j = null;
    for (let t=0;t<4 && !j;t++){
      try{
        const r = await fetch('https://api.dpd.ro/v1/track',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({userName:DPD_USER,password:DPD_PASS,language:'EN',parcels:c.map(id=>({id})),lastOperationOnly:true})});
        const txt = await r.text(); j = JSON.parse(txt);
      }catch(e){ await sleep(1200); }
    }
    (j?.parcels||[]).forEach(p=>{ const ops=p.operations||[]; const last=ops[ops.length-1];
      status[String(p.parcelId)] = dpdClass(last?.operationCode); });
    await sleep(250);
  }
}

// ---- futár-státusz: Cargus (AwbTrace) — régebbi hónapokhoz ----
if (cgAwbs.length){
  const ca = (await sb('cargus_accounts?select=username,password,api_key&limit=1'))[0];
  const CTOK = (await (await fetch('https://urgentcargus.azure-api.net/api/LoginUser',{method:'POST',
    headers:{'Content-Type':'application/json','Ocp-Apim-Subscription-Key':ca.api_key},
    body:JSON.stringify({UserName:ca.username,Password:ca.password})})).text()).replace(/^"|"$/g,'');
  const classify = events => { let del=false,bad=false; for(const e of events||[]){ const t=(e.Description||e.Text||'').toLowerCase();
    if(e.EventId===21||/livrat la destinatar/.test(t)) del=true; if(/refuz|retur/.test(t)) bad=true; }
    return del?'delivered':(bad?'retur':'transit'); };
  for (let i=0;i<cgAwbs.length;i+=40){ let arr=null;
    for (let t=0;t<5 && !arr;t++){ const r = await fetch(`https://urgentcargus.azure-api.net/api/AwbTrace?barCode=${cgAwbs.slice(i,i+40).join(',')}`,
      {headers:{'Ocp-Apim-Subscription-Key':ca.api_key,Authorization:`Bearer ${CTOK}`}});
      if (r.status===429){ await sleep(1600); continue; } if (r.ok) arr = await r.json(); else break; }
    (arr||[]).forEach(a=>{ status[a.Code||a.BarCode] = classify(a.Event||a.Events); });
    await sleep(1200);
  }
}

// ---- egy hónap teljes metrika-blokkja ----
function statusOf(d){
  if(isPulled(d)){ const s=shipOf[d.order_id]; const st=s?status[s.awb]:null;
    if(st==='delivered') return ['✅ Leszállítva',6];
    if(st==='retur')     return ['↩️ Retúr',3];
    if(st==='transit')   return ['🚚 Úton',4];
    return ['📦 Behúzva',5]; }
  if(hasRealNote(d)) return ['📞 Felkeresve — nem hozta be',2];
  if(hasNote(d))     return ['✏️ Csak jelölés — nincs érdemi jegyzet',2];
  return ['⚪ Nem felkeresve',1];
}
const prodOf = d => { const t=(d.line_items||[]).map(x=>x.title).find(t=>t&&!/prioritar|ambalare/i.test(t)); return t||'—'; };
const noteOf = d => { const n = isPulled(d) ? ((orders[d.order_id]?.note||'').trim()||d.note) : d.note; return (n||'').trim().replace(/\s+/g,' ').slice(0,140); };
const detail = d => { const [s,pri]=statusOf(d); const sh=shipOf[d.order_id];
  return { name:d.name, s, pri, amount:parseFloat(d.total_price||0), note:noteOf(d), prod:prodOf(d),
    day:buDay(d.created_at), carrier:sh?.carrier||'', awb:sh?.awb||'' }; };

function buildMonth(month){
  const pop = popOf(month);
  const received = pop.length, called = pop.filter(isCalled).length, pulled = pop.filter(isPulled).length;
  const pulledToday = pop.filter(d=>isPulled(d) && d.completed_at && buDay(d.completed_at)===TODAY).length;
  let delivered=0, retur=0, transit=0, noawb=0;
  pop.filter(isPulled).forEach(d=>{ const s=shipOf[d.order_id]; if(!s){noawb++;return;}
    const st=status[s.awb]; if(st==='delivered')delivered++; else if(st==='retur')retur++; else transit++; });
  const finalized = delivered+retur;
  const days = [...new Set(pop.map(d=>buDay(d.created_at)))].sort();
  const daily = days.map(day=>{ const g = pop.filter(d=>buDay(d.created_at)===day);
    return { label:(+day.slice(8,10))+'', recv:g.length, call:g.filter(isCalled).length, pull:g.filter(isPulled).length,
      orders: g.map(detail).sort((a,b)=>a.pri-b.pri) }; });
  return {
    month, monthName: monthLabel(month), live: month===CUR,
    received, called, pulled, conversion: received?Math.round(pulled/received*100):0,
    calledPct: received?Math.round(called/received*100):0, pulledToday: month===CUR?pulledToday:0,
    delivered, retur, transit, noawb,
    deliveredRate: finalized?Math.round(delivered/finalized*100):0, returRate: finalized?Math.round(retur/finalized*100):0,
    revenue: +pop.filter(isPulled).reduce((s,d)=>s+parseFloat(d.total_price||0),0).toFixed(2),
    commission: { fix:FIX, per:PER_DELIVERED, earned: FIX + PER_DELIVERED*delivered },
    daily,
  };
}

// ---- friss hónapok + archívum ----
const fresh = {};
for (const m of MONTHS) fresh[m] = buildMonth(m);

// lezárt hónap(ok) mentése az archívumba (titkosítva, csak ha tényleg változott)
for (const m of MONTHS){
  if (m === CUR) continue;                       // a futó hónapot nem archiváljuk — az élő
  const snap = { ...fresh[m], archivedAt:new Date().toISOString() };
  const plain = JSON.stringify({ ...snap, archivedAt:undefined });
  const h = sha(plain);
  const p = join(ARCHIVE_DIR, `${m}.json`);
  const forceRewrite = (m === PREV && !prevReadable);   // PIN-váltás után újra kell titkosítani
  if (existsSync(p) && !forceRewrite) { try { if (JSON.parse(readFileSync(p,'utf8')).h === h) { console.log(`archívum ${m}: változatlan`); continue; } } catch {} }
  const enc = await encryptData(JSON.stringify(snap), PIN);
  writeFileSync(p, JSON.stringify({ month:m, h, updatedAt:new Date().toISOString(), ...enc }));
  console.log(`archívum ${m}: mentve (${snap.received} draft, ${snap.pulled} behúzva)`);
}

// minden archivált hónap beolvasása a dashboardba
const archived = [];
for (const f of readdirSync(ARCHIVE_DIR).filter(f=>/^\d{4}-\d{2}\.json$/.test(f)).sort().reverse()){
  const m = f.slice(0,7);
  if (m === CUR) continue;
  if (fresh[m]) { archived.push(fresh[m]); continue; }
  try { archived.push(await decryptData(JSON.parse(readFileSync(join(ARCHIVE_DIR,f),'utf8')), PIN)); }
  catch(e){ console.error(`archívum ${m}: nem olvasható (PIN változott?) — kihagyva`); }
}

const months = [fresh[CUR], ...archived.filter(a=>a.month!==CUR)]
  .filter(Boolean).sort((a,b)=>b.month.localeCompare(a.month));

const DATA = {
  generatedAt: new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date()),
  builtAt: Date.now(),
  current: CUR,
  months,
};

const payload = await encryptData(JSON.stringify(DATA), PIN);
const tpl = readFileSync(join(__dir,'index.template.html'),'utf8');
const filled = tpl.replace(/const PAYLOAD = .*?;/s, () => 'const PAYLOAD = '+JSON.stringify(payload)+';');
writeFileSync(join(__dir,'index.html'), filled);
console.log('index.html kész (titkosítva, PIN a DASHBOARD_PIN-ből).');
const C = fresh[CUR];
console.log(`${C.monthName}: konverzió ${C.conversion}% | behúzott ${C.pulled}/${C.received} | leszállítva ${C.delivered} | retúr ${C.retur} | úton ${C.transit} | jutalék ${C.commission.earned} lej`);
console.log(`archívum a dashboardban: ${months.length-1} korábbi hónap`);
