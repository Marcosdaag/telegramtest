const express = require('express');
const initSqlJs = require('sql.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ============ CONFIGURACIÓN ============
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const DB_PATH = path.join(__dirname, 'miniapp.db');
const BONUS_AMOUNT = 5;
const BONUS_COOLDOWN_MS = 60 * 60 * 1000;

let db;

// ============ INIT DB ============
async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT '',
      username TEXT DEFAULT '',
      photo_url TEXT DEFAULT '',
      balance REAL DEFAULT 0,
      referral_code TEXT UNIQUE,
      referred_by INTEGER DEFAULT NULL,
      last_bonus INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  saveDB();
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ============ HELPERS ============
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getOrCreateUser(tgData) {
  let u = queryOne('SELECT * FROM users WHERE telegram_id = ?', [tgData.id]);
  if (u) {
    db.run('UPDATE users SET first_name=?, last_name=?, username=?, photo_url=? WHERE telegram_id=?',
      [tgData.first_name || '', tgData.last_name || '', tgData.username || '', tgData.photo_url || '', tgData.id]);
    saveDB();
    return queryOne('SELECT * FROM users WHERE telegram_id = ?', [tgData.id]);
  }
  const code = crypto.randomBytes(4).toString('hex');
  db.run(`INSERT INTO users (telegram_id, first_name, last_name, username, photo_url, referral_code)
          VALUES (?, ?, ?, ?, ?, ?)`,
    [tgData.id, tgData.first_name || '', tgData.last_name || '', tgData.username || '', tgData.photo_url || '', code]);
  saveDB();
  return queryOne('SELECT * FROM users WHERE telegram_id = ?', [tgData.id]);
}

// ============ API ============
app.post('/api/profile', (req, res) => {
  try {
    const { user, ref } = req.body;
    if (!user || !user.id) return res.status(400).json({ error: 'Datos inválidos' });
    const u = getOrCreateUser(user);
    if (ref && !u.referred_by) {
      const referrer = queryOne('SELECT * FROM users WHERE referral_code = ?', [ref]);
      if (referrer && referrer.telegram_id !== u.telegram_id) {
        db.run('UPDATE users SET referred_by = ? WHERE telegram_id = ?', [referrer.telegram_id, u.telegram_id]);
        db.run('UPDATE users SET balance = balance + 10 WHERE telegram_id = ?', [referrer.telegram_id]);
        saveDB();
      }
    }
    const fresh = queryOne('SELECT * FROM users WHERE telegram_id = ?', [u.telegram_id]);
    const refs = queryOne('SELECT COUNT(*) as count FROM users WHERE referred_by = ?', [u.telegram_id]);
    res.json({ ...fresh, referral_link: `${APP_URL}?ref=${fresh.referral_code}`, referral_count: refs.count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bonus', (req, res) => {
  try {
    const { telegram_id } = req.body;
    const u = queryOne('SELECT * FROM users WHERE telegram_id = ?', [telegram_id]);
    if (!u) return res.status(404).json({ error: 'No encontrado' });
    const now = Date.now();
    if (now - (u.last_bonus || 0) < BONUS_COOLDOWN_MS) {
      return res.json({ success: false, remaining: BONUS_COOLDOWN_MS - (now - u.last_bonus) });
    }
    db.run('UPDATE users SET balance = balance + ?, last_bonus = ? WHERE telegram_id = ?', [BONUS_AMOUNT, now, telegram_id]);
    saveDB();
    const updated = queryOne('SELECT balance FROM users WHERE telegram_id = ?', [telegram_id]);
    res.json({ success: true, balance: updated.balance, next_bonus: now + BONUS_COOLDOWN_MS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdraw', (req, res) => {
  try {
    const { telegram_id, amount } = req.body;
    if (!telegram_id || !amount || amount <= 0) return res.status(400).json({ error: 'Datos inválidos' });
    const u = queryOne('SELECT * FROM users WHERE telegram_id = ?', [telegram_id]);
    if (!u) return res.status(404).json({ error: 'No encontrado' });
    if (u.balance < amount) return res.json({ success: false, message: 'Saldo insuficiente' });
    if (amount < 10) return res.json({ success: false, message: 'Mínimo: 10 TOK' });
    db.run('UPDATE users SET balance = balance - ? WHERE telegram_id = ?', [amount, telegram_id]);
    db.run('INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)', [telegram_id, amount]);
    saveDB();
    const updated = queryOne('SELECT balance FROM users WHERE telegram_id = ?', [telegram_id]);
    res.json({ success: true, balance: updated.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdrawals', (req, res) => {
  try {
    const { telegram_id } = req.body;
    const rows = queryAll('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [telegram_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ FRONTEND ============
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>TOK Mini App</title>
<script src="https://telegram.org/js/telegram-web-app.js"><\/script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0e1a;--card:rgba(255,255,255,0.05);--cb:rgba(255,255,255,0.08);--ac:#7c5cfc;--ac2:#00d4aa;--t:#e8e8f0;--t2:#8888aa;--dng:#ff4466;--ok:#00d4aa}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--t);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(circle at 30% 20%,rgba(124,92,252,0.08) 0%,transparent 50%),radial-gradient(circle at 70% 80%,rgba(0,212,170,0.06) 0%,transparent 50%);z-index:0;pointer-events:none}
.c{position:relative;z-index:1;padding:16px;max-width:420px;margin:0 auto;padding-bottom:100px}
.ld{display:flex;align-items:center;justify-content:center;height:100vh}
.sp{width:40px;height:40px;border:3px solid var(--cb);border-top-color:var(--ac);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.ph{text-align:center;padding:28px 20px;background:linear-gradient(135deg,rgba(124,92,252,0.12),rgba(0,212,170,0.08));border:1px solid var(--cb);border-radius:20px;margin-bottom:16px;backdrop-filter:blur(10px)}
.av{width:80px;height:80px;border-radius:50%;border:3px solid var(--ac);object-fit:cover;margin-bottom:12px;box-shadow:0 0 20px rgba(124,92,252,0.3)}
.ap{width:80px;height:80px;border-radius:50%;background:linear-gradient(135deg,var(--ac),var(--ac2));display:inline-flex;align-items:center;justify-content:center;font-size:32px;font-weight:800;margin-bottom:12px;box-shadow:0 0 20px rgba(124,92,252,0.3)}
.un{font-size:20px;font-weight:700;margin-bottom:4px}
.uh{color:var(--t2);font-size:13px}
.bc{background:linear-gradient(135deg,#7c5cfc,#5a3de8,#00d4aa);border-radius:18px;padding:24px;margin-bottom:16px;text-align:center;position:relative;overflow:hidden;box-shadow:0 8px 32px rgba(124,92,252,0.25)}
.bc::after{content:'';position:absolute;top:-50%;right:-30%;width:200px;height:200px;background:rgba(255,255,255,0.06);border-radius:50%}
.bl{font-size:13px;opacity:.85;margin-bottom:6px;letter-spacing:1px;text-transform:uppercase}
.bv{font-size:36px;font-weight:800;position:relative;z-index:1}
.bv span{font-size:18px;font-weight:500;opacity:.9}
.cd{background:var(--card);border:1px solid var(--cb);border-radius:16px;padding:18px;margin-bottom:12px;backdrop-filter:blur(8px)}
.ct{font-size:13px;color:var(--t2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px;font-weight:600}
.bb{width:100%;padding:16px;border:none;border-radius:14px;font-family:'Inter',sans-serif;font-size:15px;font-weight:700;cursor:pointer;transition:all .3s;overflow:hidden}
.bb.act{background:linear-gradient(135deg,var(--ac2),#00b894);color:#fff;box-shadow:0 4px 20px rgba(0,212,170,0.3)}
.bb.act:hover{transform:translateY(-1px)}
.bb.cld{background:var(--card);color:var(--t2);border:1px solid var(--cb);cursor:not-allowed}
.bt{font-size:22px;font-weight:800;display:block;margin-top:4px}
.rlb{display:flex;align-items:center;gap:8px;background:rgba(0,0,0,0.25);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.rlb input{flex:1;background:none;border:none;color:var(--t);font-family:'Inter',sans-serif;font-size:12px;outline:none}
.cpb{background:var(--ac);border:none;color:#fff;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif}
.rs{display:flex;gap:12px}
.rst{flex:1;background:rgba(124,92,252,0.1);border-radius:10px;padding:12px;text-align:center}
.rsv{font-size:20px;font-weight:800;color:var(--ac)}
.rsl{font-size:11px;color:var(--t2);margin-top:2px}
.wi{width:100%;padding:14px;background:rgba(0,0,0,0.25);border:1px solid var(--cb);border-radius:10px;color:var(--t);font-family:'Inter',sans-serif;font-size:15px;margin-bottom:10px;outline:none;transition:border-color .2s}
.wi:focus{border-color:var(--ac)}
.wb{width:100%;padding:14px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--ac),#5a3de8);color:#fff;font-family:'Inter',sans-serif;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(124,92,252,0.25)}
.mn{font-size:11px;color:var(--t2);margin-bottom:10px}
.hi{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--cb)}
.hi:last-child{border:none}
.ha{font-weight:700;color:var(--dng)}
.hs{font-size:11px;padding:3px 8px;border-radius:6px;font-weight:600}
.hs.pending{background:rgba(255,170,0,0.15);color:#ffaa00}
.hs.completed{background:rgba(0,212,170,0.15);color:var(--ok)}
.hd{font-size:11px;color:var(--t2)}
.tt{position:fixed;bottom:30px;left:50%;transform:translateX(-50%) translateY(100px);background:#1e2235;color:var(--t);padding:12px 24px;border-radius:12px;font-size:13px;font-weight:500;z-index:999;transition:transform .4s cubic-bezier(.16,1,.3,1);border:1px solid var(--cb);box-shadow:0 8px 32px rgba(0,0,0,0.4)}
.tt.sh{transform:translateX(-50%) translateY(0)}
.em{text-align:center;color:var(--t2);padding:20px;font-size:13px}
@keyframes fi{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.fin{animation:fi .5s ease forwards}
</style>
</head>
<body>
<div id="ld" class="ld"><div class="sp"></div></div>
<div id="app" class="c" style="display:none"></div>
<div id="tt" class="tt"></div>
<script>
const tg=window.Telegram?.WebApp;
if(tg){tg.ready();tg.expand()}
let U=null,bI=null;
async function init(){
  const tu=tg?.initDataUnsafe?.user||{id:123456789,first_name:'Test',last_name:'User',username:'testuser',photo_url:''};
  const p=new URLSearchParams(window.location.search);
  const ref=p.get('ref')||tg?.initDataUnsafe?.start_param||null;
  try{
    const r=await fetch('/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:tu,ref})});
    U=await r.json();
    document.getElementById('ld').style.display='none';
    document.getElementById('app').style.display='block';
    render();
  }catch(e){document.getElementById('ld').innerHTML='<p style="color:#ff4466">Error</p>'}
}
function render(){
  const u=U,ini=(u.first_name||'U')[0].toUpperCase(),fn=[u.first_name,u.last_name].filter(Boolean).join(' ')||'Usuario';
  const avH=u.photo_url?'<img class="av" src="'+u.photo_url+'" alt="">':'<div class="ap">'+ini+'</div>';
  document.getElementById('app').innerHTML=
    '<div class="fin">'+
    '<div class="ph">'+avH+'<div class="un">'+esc(fn)+'</div>'+(u.username?'<div class="uh">@'+esc(u.username)+'</div>':'')+'</div>'+
    '<div class="bc"><div class="bl">Tu Balance</div><div class="bv">'+Number(u.balance).toFixed(2)+' <span>TOK</span></div></div>'+
    '<div class="cd"><div class="ct">\\u26A1 Bonus Cada Hora</div><button id="bBtn" class="bb" onclick="claim()"></button></div>'+
    '<div class="cd"><div class="ct">\\uD83D\\uDC65 Enlace de Afiliado</div>'+
      '<div class="rlb"><input id="rI" value="'+esc(u.referral_link)+'" readonly><button class="cpb" onclick="cpR()">Copiar</button></div>'+
      '<div class="rs"><div class="rst"><div class="rsv">'+(u.referral_count||0)+'</div><div class="rsl">Referidos</div></div>'+
      '<div class="rst"><div class="rsv">+10</div><div class="rsl">TOK por ref.</div></div></div></div>'+
    '<div class="cd"><div class="ct">\\uD83D\\uDCB8 Solicitar Retiro</div>'+
      '<div class="mn">M\\u00EDnimo: 10 TOK \\u00B7 Disponible: '+Number(u.balance).toFixed(2)+' TOK</div>'+
      '<input id="wA" class="wi" type="number" placeholder="Cantidad en TOK" min="10" step="0.01">'+
      '<button class="wb" onclick="wdr()">Solicitar Retiro</button></div>'+
    '<div class="cd"><div class="ct">\\uD83D\\uDCCB Historial</div><div id="ht"><div class="em">Cargando...</div></div></div></div>';
  updB();
  if(bI)clearInterval(bI);
  bI=setInterval(updB,1000);
  ldH();
}
function updB(){
  const b=document.getElementById('bBtn');if(!b)return;
  const d=Date.now()-(U.last_bonus||0);
  if(d>=3600000){b.className='bb act';b.innerHTML='\\uD83C\\uDF81 Reclamar +5 TOK'}
  else{b.className='bb cld';const r=3600000-d,m=Math.floor(r/60000),s=Math.floor((r%60000)/1000);
  b.innerHTML='Pr\\u00F3ximo bonus en<span class="bt">'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'</span>'}
}
async function claim(){
  const b=document.getElementById('bBtn');if(!b||b.classList.contains('cld'))return;
  try{const r=await fetch('/api/bonus',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram_id:U.telegram_id})});
  const d=await r.json();
  if(d.success){U.balance=d.balance;U.last_bonus=Date.now();toast('\\uD83C\\uDF89 +5 TOK!');render()}
  else{U.last_bonus=Date.now()-(3600000-d.remaining);updB()}}catch(e){toast('Error')}
}
async function wdr(){
  const a=parseFloat(document.getElementById('wA').value);
  if(!a||a<10){toast('M\\u00EDnimo 10 TOK');return}
  if(a>U.balance){toast('Saldo insuficiente');return}
  try{const r=await fetch('/api/withdraw',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram_id:U.telegram_id,amount:a})});
  const d=await r.json();
  if(d.success){U.balance=d.balance;toast('\\u2705 Retiro: '+a+' TOK');render()}
  else toast(d.message||'Error')}catch(e){toast('Error')}
}
async function ldH(){
  try{const r=await fetch('/api/withdrawals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram_id:U.telegram_id})});
  const d=await r.json();const e=document.getElementById('ht');
  if(!d.length){e.innerHTML='<div class="em">Sin retiros a\\u00FAn</div>';return}
  e.innerHTML=d.map(w=>'<div class="hi"><div><div class="ha">-'+Number(w.amount).toFixed(2)+' TOK</div><div class="hd">'+new Date(w.created_at).toLocaleDateString('es')+'</div></div><span class="hs '+w.status+'">'+(w.status==='pending'?'Pendiente':'Completado')+'</span></div>').join('')}catch(e){}
}
function cpR(){navigator.clipboard.writeText(document.getElementById('rI').value).then(()=>toast('\\uD83D\\uDCCB Copiado!'))}
function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
function toast(m){const t=document.getElementById('tt');t.textContent=m;t.classList.add('sh');setTimeout(()=>t.classList.remove('sh'),2500)}
init();
<\/script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML);
});

// ============ START ============
initDB().then(() => {
  app.listen(PORT, () => console.log(`\\n  🚀 TOK Mini App en http://localhost:${PORT}\\n`));
}).catch(e => { console.error('Error DB:', e); process.exit(1); });
