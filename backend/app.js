require('dotenv').config();
const express = require('express');
const initSqlJs = require('sql.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ============ CONFIGURACIÓN (valores desde .env) ============
const CONFIG = {
  PORT: parseInt(process.env.PORT) || 3000,
  APP_URL: process.env.APP_URL || 'http://localhost:3000',
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  BOT_USERNAME: process.env.BOT_USERNAME || 'tokfarmbot',
  BOT_SHORTNAME: process.env.BOT_SHORTNAME || 'login',
  DB_PATH: process.env.DB_PATH || path.join(__dirname, 'miniapp.db'),
  BONUS_AMOUNT: parseFloat(process.env.BONUS_AMOUNT) || 5,
  BONUS_COOLDOWN_MS: (parseInt(process.env.BONUS_COOLDOWN_MINUTES) || 60) * 60 * 1000,
  REFERRAL_BONUS: parseFloat(process.env.REFERRAL_BONUS) || 10,
  MIN_WITHDRAWAL: parseFloat(process.env.MIN_WITHDRAWAL) || 10,
};

let db;

// ============ INIT DB ============
async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(CONFIG.DB_PATH)) {
    const buf = fs.readFileSync(CONFIG.DB_PATH);
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
  fs.writeFileSync(CONFIG.DB_PATH, Buffer.from(data));
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

// ============ API: Configuración pública ============
app.get('/api/config', (req, res) => {
  res.json({
    bonus_amount: CONFIG.BONUS_AMOUNT,
    bonus_cooldown_ms: CONFIG.BONUS_COOLDOWN_MS,
    referral_bonus: CONFIG.REFERRAL_BONUS,
    min_withdrawal: CONFIG.MIN_WITHDRAWAL,
  });
});

// ============ API: Perfil ============
app.post('/api/profile', (req, res) => {
  try {
    const { user, ref } = req.body;
    if (!user || !user.id) return res.status(400).json({ error: 'Datos inválidos' });
    const u = getOrCreateUser(user);
    if (ref && !u.referred_by) {
      const referrer = queryOne('SELECT * FROM users WHERE referral_code = ?', [ref]);
      if (referrer && referrer.telegram_id !== u.telegram_id) {
        db.run('UPDATE users SET referred_by = ? WHERE telegram_id = ?', [referrer.telegram_id, u.telegram_id]);
        db.run('UPDATE users SET balance = balance + ? WHERE telegram_id = ?', [CONFIG.REFERRAL_BONUS, referrer.telegram_id]);
        saveDB();
      }
    }
    const fresh = queryOne('SELECT * FROM users WHERE telegram_id = ?', [u.telegram_id]);
    const refs = queryOne('SELECT COUNT(*) as count FROM users WHERE referred_by = ?', [u.telegram_id]);
    res.json({
      ...fresh,
      referral_link: `https://t.me/${CONFIG.BOT_USERNAME}/${CONFIG.BOT_SHORTNAME}?startapp=${fresh.referral_code}`,
      referral_count: refs.count,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ API: Bonus ============
app.post('/api/bonus', (req, res) => {
  try {
    const { telegram_id } = req.body;
    const u = queryOne('SELECT * FROM users WHERE telegram_id = ?', [telegram_id]);
    if (!u) return res.status(404).json({ error: 'No encontrado' });
    const now = Date.now();
    if (now - (u.last_bonus || 0) < CONFIG.BONUS_COOLDOWN_MS) {
      return res.json({ success: false, remaining: CONFIG.BONUS_COOLDOWN_MS - (now - u.last_bonus) });
    }
    db.run('UPDATE users SET balance = balance + ?, last_bonus = ? WHERE telegram_id = ?',
      [CONFIG.BONUS_AMOUNT, now, telegram_id]);
    saveDB();
    const updated = queryOne('SELECT balance FROM users WHERE telegram_id = ?', [telegram_id]);
    res.json({ success: true, balance: updated.balance, next_bonus: now + CONFIG.BONUS_COOLDOWN_MS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ API: Retiro ============
app.post('/api/withdraw', (req, res) => {
  try {
    const { telegram_id, amount } = req.body;
    if (!telegram_id || !amount || amount <= 0) return res.status(400).json({ error: 'Datos inválidos' });
    const u = queryOne('SELECT * FROM users WHERE telegram_id = ?', [telegram_id]);
    if (!u) return res.status(404).json({ error: 'No encontrado' });
    if (u.balance < amount) return res.json({ success: false, message: 'Saldo insuficiente' });
    if (amount < CONFIG.MIN_WITHDRAWAL) return res.json({ success: false, message: `Mínimo: ${CONFIG.MIN_WITHDRAWAL} TOK` });
    db.run('UPDATE users SET balance = balance - ? WHERE telegram_id = ?', [amount, telegram_id]);
    db.run('INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)', [telegram_id, amount]);
    saveDB();
    const updated = queryOne('SELECT balance FROM users WHERE telegram_id = ?', [telegram_id]);
    res.json({ success: true, balance: updated.balance });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ API: Historial ============
app.post('/api/withdrawals', (req, res) => {
  try {
    const { telegram_id } = req.body;
    const rows = queryAll('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [telegram_id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ START ============
initDB().then(() => {
  app.listen(CONFIG.PORT, () => {
    console.log(`\n  🚀 TOK Mini App en http://localhost:${CONFIG.PORT}\n`);
  });
}).catch(e => {
  console.error('Error DB:', e);
  process.exit(1);
});
