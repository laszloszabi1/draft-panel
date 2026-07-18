// Zsolt draft-behúzó dashboard — valós adat generátor (JÚLIUS-only).
// Futtatás: node generate.mjs  → kiírja index.html-t a valós számokkal.
// Creds: env (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) VAGY ~/.env.local (local dev).
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto as wc } from 'node:crypto';
const __dir = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// AES-GCM titkosítás PIN-nel (a nyers számok SOHA nem kerülnek a publikus HTML-be)
const PIN = process.env.DASHBOARD_PIN || '1234';
async function encryptData(plain, pin){
  const salt = wc.getRandomValues(new Uint8Array(16));
  const iv = wc.getRandomValues(new Uint8Array(12));
  const km = await wc.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await wc.subtle.deriveKey({name:'PBKDF2',salt,iterations:200000,hash:'SHA-256'}, km, {name:'AES-GCM',length:256}, false, ['encrypt']);
  const ct = await wc.subtle.encrypt({name:'AES-GCM',iv}, key, new TextEncoder().encode(plain));
  const b64 = b => Buffer.from(b).toString('base64');
  return { s:b64(salt), i:b64(iv), c:Buffer.from(ct).toString('base64') };
}

// ---- config ----
const MONTH = process.env.DASH_MONTH || '2026-07';      // csak ez a hónap
const FIX = 1000, PER_DELIVERED = 10;                   // 1000 fix + 10 lej/leszállított
const KULDES = 16.52, RETDIJ = 1.57, CSOMAG = 5.30;     // Cargus + csomagolás

// ---- creds ----
let SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  const env = Object.fromEntries(readFileSync(homedir()+'/Desktop/Claude Code Test/mystore-hq/.env.local','utf8')
    .split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
  SB_URL = env.NEXT_PUBLIC_SUPABASE_URL; SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
}
const sb = p => fetch(`${SB_URL}/rest/v1/${p}`,{headers:{apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`}}).then(r=>r.json());
const buDay = iso => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));

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

// July population + funnel
const pop = drafts.filter(d => (d.tags||'').toLowerCase().includes('easysell-abandoned-checkout') && buDay(d.created_at).slice(0,7)===MONTH);
const hasNote = d => !!(d.note && d.note.trim());
const isPulled = d => d.status==='completed' && d.order_id;
const isCalled = d => isPulled(d) || hasNote(d);
const received = pop.length, called = pop.filter(isCalled).length, pulled = pop.filter(isPulled).length;
const revenue = pop.filter(isPulled).reduce((s,d)=>s+parseFloat(d.total_price||0),0);
const today = buDay(new Date().toISOString());
const pulledToday = pop.filter(d=>isPulled(d) && d.completed_at && buDay(d.completed_at)===today).length;

// ---- delivery via LIVE Cargus (shipments-tükör késik) ----
const pl = pop.filter(isPulled); const ids = pl.map(d=>String(d.order_id));
const orders = {};
for (let i=0;i<ids.length;i+=250){ const chunk = ids.slice(i,i+250);
  const r = await fetch(`${base}/orders.json?ids=${chunk.join(',')}&status=any&limit=250&fields=id,cancelled_at,fulfillments,note`,{headers:H});
  (await r.json()).orders?.forEach(o=>orders[o.id]=o); }
const awbOf = {};
pl.forEach(d=>{ const o = orders[d.order_id]; if(!o||o.cancelled_at) return;
  const tn = (o.fulfillments||[]).map(f=>f.tracking_number).find(Boolean); if(tn) awbOf[d.order_id]=tn; });
const awbs = [...new Set(Object.values(awbOf))];

const ca = (await sb('cargus_accounts?select=username,password,api_key&limit=1'))[0];
const CTOK = (await (await fetch('https://urgentcargus.azure-api.net/api/LoginUser',{method:'POST',
  headers:{'Content-Type':'application/json','Ocp-Apim-Subscription-Key':ca.api_key},
  body:JSON.stringify({UserName:ca.username,Password:ca.password})})).text()).replace(/^"|"$/g,'');
function classify(events){ let del=false,bad=false; for(const e of events||[]){ const t=(e.Description||e.Text||'').toLowerCase();
  if(e.EventId===21||/livrat la destinatar/.test(t)) del=true; if(/refuz|retur/.test(t)) bad=true; }
  return del?'delivered':(bad?'retur':'transit'); }
const status = {};
for (let i=0;i<awbs.length;i+=40){ let arr=null;
  for (let t=0;t<5 && !arr;t++){ const r = await fetch(`https://urgentcargus.azure-api.net/api/AwbTrace?barCode=${awbs.slice(i,i+40).join(',')}`,
    {headers:{'Ocp-Apim-Subscription-Key':ca.api_key,Authorization:`Bearer ${CTOK}`}});
    if (r.status===429){ await sleep(1600); continue; } if (r.ok) arr = await r.json(); else break; }
  (arr||[]).forEach(a=>{ status[a.Code||a.BarCode] = classify(a.Event||a.Events); });
  await sleep(1200);
}
let delivered=0, retur=0, transit=0, noawb=0;
pl.forEach(d=>{ const awb=awbOf[d.order_id]; if(!awb){noawb++;return;} const st=status[awb];
  if(st==='delivered')delivered++; else if(st==='retur')retur++; else transit++; });
const finalized = delivered+retur;
const earned = FIX + PER_DELIVERED*delivered;

// ---- per-draft detail (grouped by day, sorted by status) ----
function statusOf(d){
  if(isPulled(d)){ const awb=awbOf[d.order_id]; const st=awb?status[awb]:null;
    if(st==='delivered') return ['✅ Leszállítva',6];
    if(st==='retur')     return ['↩️ Retúr',3];
    if(st==='transit')   return ['🚚 Úton',4];
    return ['📦 Behúzva',5]; }
  if(hasNote(d)) return ['📞 Felkeresve — nem hozta be',2];
  return ['⚪ Nem felkeresve',1];
}
const prodOf = d => { const t=(d.line_items||[]).map(x=>x.title).find(t=>t&&!/prioritar|ambalare/i.test(t)); return t||'—'; };
const noteOf = d => { const n = isPulled(d) ? ((orders[d.order_id]?.note||'').trim()||d.note) : d.note; return (n||'').trim().replace(/\s+/g,' ').slice(0,140); };
const detail = d => { const [s,pri]=statusOf(d); return { name:d.name, s, pri, amount:parseFloat(d.total_price||0), note:noteOf(d), prod:prodOf(d) }; };

const days = [...new Set(pop.map(d=>buDay(d.created_at)))].filter(x=>x.slice(0,7)===MONTH).sort();
const daily = days.map(day=>{ const g = pop.filter(d=>buDay(d.created_at)===day);
  return { label:(+day.slice(8,10))+'', recv:g.length, call:g.filter(isCalled).length, pull:g.filter(isPulled).length,
    orders: g.map(detail).sort((a,b)=>a.pri-b.pri) }; });

const DATA = {
  generatedAt: new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date()),
  month: MONTH, monthName: 'Július',
  received, called, pulled, conversion: received?Math.round(pulled/received*100):0,
  calledPct: received?Math.round(called/received*100):0, pulledToday,
  delivered, retur, transit, noawb,
  deliveredRate: finalized?Math.round(delivered/finalized*100):0, returRate: finalized?Math.round(retur/finalized*100):0,
  commission: { fix:FIX, per:PER_DELIVERED, earned },
  daily,
};

const payload = await encryptData(JSON.stringify(DATA), PIN);
const tpl = readFileSync(join(__dir,'index.template.html'),'utf8');
const filled = tpl.replace(/const PAYLOAD = .*?;/s, () => 'const PAYLOAD = '+JSON.stringify(payload)+';');
writeFileSync(join(__dir,'index.html'), filled);
console.log('index.html kész (titkosítva, PIN a DASHBOARD_PIN-ből).');
console.log(`Konverzió ${DATA.conversion}% | behúzott ${pulled} | leszállítva ${delivered} | retúr ${retur} | úton ${transit} | eddig kerestél ${earned} lej`);
