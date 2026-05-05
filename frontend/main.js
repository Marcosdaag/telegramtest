// ============ Telegram WebApp Init ============
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('secondary_bg_color');
}

let U = null;   // current user
let CFG = {};   // server config
let bonusInterval = null;

// ============ Navigation ============
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchPage(btn.dataset.page));
});

function switchPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + name);
  if (page) {
    page.classList.add('active');
    // Re-trigger animation
    page.style.animation = 'none';
    page.offsetHeight;
    page.style.animation = '';
  }
  const navBtn = document.querySelector(`.nav-item[data-page="${name}"]`);
  if (navBtn) navBtn.classList.add('active');
}

// ============ Init ============
async function init() {
  try {
    const cfgRes = await fetch('/api/config');
    CFG = await cfgRes.json();
  } catch (e) {
    CFG = { bonus_amount: 0.1, bonus_cooldown_ms: 7200000, referral_bonus: 0.5, min_withdrawal: 10 };
  }

  const tgUser = tg?.initDataUnsafe?.user || {
    id: 123456789,
    first_name: 'Test',
    last_name: 'User',
    username: 'testuser',
    photo_url: ''
  };

  const params = new URLSearchParams(window.location.search);
  const ref = tg?.initDataUnsafe?.start_param || params.get('startapp') || params.get('ref') || null;

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: tgUser, ref })
    });
    U = await res.json();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    renderAll();
  } catch (e) {
    document.getElementById('loading').innerHTML =
      '<div class="load-icon">❌</div><div class="load-text">Error de conexión</div>';
  }
}

// ============ Render All Pages ============
function renderAll() {
  renderHome();
  renderFarm();
  renderFriends();
  renderWallet();
}

// ============ HOME ============
function renderHome() {
  const u = U;
  const initial = (u.first_name || 'U')[0].toUpperCase();
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Usuario';

  const avatarHTML = u.photo_url
    ? `<img class="home-avatar" src="${u.photo_url}" alt="">`
    : `<div class="home-avatar-placeholder">${initial}</div>`;

  const hours = Math.floor(CFG.bonus_cooldown_ms / 3600000);
  const cooldownLabel = hours > 1 ? `${hours}h` : '1h';

  document.getElementById('page-home').innerHTML = `
    <div class="home-header">
      ${avatarHTML}
      <div>
        <div class="home-greeting">Bienvenido de vuelta 👋</div>
        <div class="home-name">${esc(fullName)}</div>
      </div>
    </div>

    <div class="balance-widget">
      <div class="balance-label">Tu Balance</div>
      <div class="balance-amount">${formatTok(u.balance)} <small>TOK</small></div>
    </div>

    <div class="quick-stats">
      <div class="stat-box">
        <div class="stat-icon">👥</div>
        <div class="stat-val">${u.referral_count || 0}</div>
        <div class="stat-lbl">Amigos</div>
      </div>
      <div class="stat-box">
        <div class="stat-icon">🌾</div>
        <div class="stat-val">+${CFG.bonus_amount}</div>
        <div class="stat-lbl">/ ${cooldownLabel}</div>
      </div>
      <div class="stat-box">
        <div class="stat-icon">🎁</div>
        <div class="stat-val">+${CFG.referral_bonus}</div>
        <div class="stat-lbl">Por ref.</div>
      </div>
    </div>
  `;
}

// ============ FARM ============
function renderFarm() {
  document.getElementById('page-farm').innerHTML = `
    <div class="farm-scene">
      <div class="farm-emoji" id="farmEmoji">🌾</div>
      <div class="farm-status" id="farmStatus"></div>
      <div class="farm-reward">+${CFG.bonus_amount} TOK</div>
    </div>

    <div class="progress-bar"><div class="progress-fill" id="farmProgress"></div></div>
    <div class="farm-timer" id="farmTimer"></div>

    <button id="farmBtn" class="btn" onclick="claimBonus()"></button>
  `;

  updateFarm();
  if (bonusInterval) clearInterval(bonusInterval);
  bonusInterval = setInterval(updateFarm, 1000);
}

function updateFarm() {
  const btn = document.getElementById('farmBtn');
  const timer = document.getElementById('farmTimer');
  const status = document.getElementById('farmStatus');
  const progress = document.getElementById('farmProgress');
  const emoji = document.getElementById('farmEmoji');
  if (!btn) return;

  const last = U.last_bonus || 0;
  const now = Date.now();
  const diff = now - last;
  const cooldown = CFG.bonus_cooldown_ms;

  if (diff >= cooldown) {
    btn.className = 'btn btn-primary';
    btn.textContent = '🌾 Cosechar TOK';
    timer.textContent = '';
    status.textContent = '¡Tu cosecha está lista!';
    if (progress) progress.style.width = '100%';
    if (emoji) emoji.textContent = '🌾';
  } else {
    btn.className = 'btn btn-disabled';
    btn.textContent = 'Creciendo...';
    const rem = cooldown - diff;
    const h = Math.floor(rem / 3600000);
    const m = Math.floor((rem % 3600000) / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    timer.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    status.textContent = 'Tu cosecha está creciendo 🌱';

    const pct = ((diff / cooldown) * 100).toFixed(1);
    if (progress) progress.style.width = pct + '%';

    // Emoji stages
    if (emoji) {
      if (pct < 25) emoji.textContent = '🌱';
      else if (pct < 50) emoji.textContent = '🌿';
      else if (pct < 75) emoji.textContent = '🌻';
      else emoji.textContent = '🌾';
    }
  }
}

async function claimBonus() {
  const btn = document.getElementById('farmBtn');
  if (!btn || btn.classList.contains('btn-disabled')) return;

  const emoji = document.getElementById('farmEmoji');
  if (emoji) {
    emoji.classList.add('shake');
    setTimeout(() => emoji.classList.remove('shake'), 600);
  }

  try {
    const res = await fetch('/api/bonus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: U.telegram_id })
    });
    const data = await res.json();

    if (data.success) {
      U.balance = data.balance;
      U.last_bonus = Date.now();
      toast(`🌾 +${CFG.bonus_amount} TOK cosechados!`);
      renderAll();
    } else {
      U.last_bonus = Date.now() - (CFG.bonus_cooldown_ms - data.remaining);
      updateFarm();
    }
  } catch (e) {
    toast('Error al cosechar');
  }
}

// ============ FRIENDS ============
function renderFriends() {
  document.getElementById('page-friends').innerHTML = `
    <div class="invite-banner">
      <div class="invite-title">Invita amigos y gana</div>
      <div class="invite-sub">+${CFG.referral_bonus} TOK por cada amigo que se una</div>
    </div>

    <div class="invite-actions">
      <button class="btn btn-primary" onclick="shareLink()">📤 Invitar</button>
      <button class="btn btn-secondary" onclick="copyRef()">📋 Copiar link</button>
    </div>

    <div class="quick-stats mb-16" style="grid-template-columns: 1fr 1fr;">
      <div class="ref-count-card">
        <div class="ref-count-val">${U.referral_count || 0}</div>
        <div class="ref-count-lbl">Amigos invitados</div>
      </div>
      <div class="ref-count-card">
        <div class="ref-count-val">${formatTok((U.referral_count || 0) * CFG.referral_bonus)}</div>
        <div class="ref-count-lbl">TOK ganados</div>
      </div>
    </div>

    <div class="section-title">Tu enlace</div>
    <div class="card" style="word-break:break-all; font-size:13px; font-weight:600; color:var(--text2);">
      ${esc(U.referral_link)}
    </div>
  `;
}

function shareLink() {
  if (tg) {
    const text = `🌾 Únete a TOK Farm y empieza a ganar TOK gratis! Cosecha cada hora y gana tokens.`;
    const url = U.referral_link;
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
  } else {
    copyRef();
  }
}

function copyRef() {
  navigator.clipboard.writeText(U.referral_link).then(() => toast('📋 Enlace copiado!'));
}

// ============ WALLET ============
function renderWallet() {
  document.getElementById('page-wallet').innerHTML = `
    <div class="wallet-balance">
      <div class="wallet-bal-label">Disponible</div>
      <div class="wallet-bal-amount">${formatTok(U.balance)} <small>TOK</small></div>
    </div>

    <div class="section-title">Solicitar retiro</div>
    <div class="card">
      <input id="withdrawAmount" class="input-field" type="number" placeholder="Cantidad en TOK"
             min="${CFG.min_withdrawal}" step="0.01">
      <div class="input-hint">Mínimo: ${CFG.min_withdrawal} TOK</div>
      <button class="btn btn-mint" onclick="withdraw()">Solicitar retiro</button>
    </div>

    <div class="section-title">Historial</div>
    <div class="card" id="history">
      <div class="empty-state">
        <div class="empty-icon">⏳</div>
        <div class="empty-text">Cargando...</div>
      </div>
    </div>
  `;

  loadHistory();
}

async function withdraw() {
  const input = document.getElementById('withdrawAmount');
  const amount = parseFloat(input.value);

  if (!amount || amount < CFG.min_withdrawal) {
    toast(`Mínimo ${CFG.min_withdrawal} TOK`);
    return;
  }
  if (amount > U.balance) {
    toast('Saldo insuficiente');
    return;
  }

  try {
    const res = await fetch('/api/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: U.telegram_id, amount })
    });
    const data = await res.json();

    if (data.success) {
      U.balance = data.balance;
      toast(`✅ Retiro: ${amount} TOK`);
      renderAll();
    } else {
      toast(data.message || 'Error');
    }
  } catch (e) {
    toast('Error al solicitar');
  }
}

async function loadHistory() {
  try {
    const res = await fetch('/api/withdrawals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: U.telegram_id })
    });
    const data = await res.json();
    const el = document.getElementById('history');

    if (!data.length) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-text">Aún no hay retiros</div>
        </div>`;
      return;
    }

    el.innerHTML = data.map(w => `
      <div class="history-item">
        <div class="h-left">
          <div class="h-icon out">📤</div>
          <div>
            <div class="h-amount">-${formatTok(w.amount)} TOK</div>
            <div class="h-date">${new Date(w.created_at).toLocaleDateString('es')}</div>
          </div>
        </div>
        <span class="h-badge ${w.status}">${w.status === 'pending' ? 'Pendiente' : 'Completado'}</span>
      </div>
    `).join('');
  } catch (e) { /* silent */ }
}

// ============ Utils ============
function formatTok(n) {
  return Number(n || 0).toFixed(2);
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

let toastTimeout = null;
function toast(msg) {
  const t = document.getElementById('toast');
  if (toastTimeout) clearTimeout(toastTimeout);
  t.classList.remove('show');
  // Force reflow to restart transition
  void t.offsetHeight;
  t.textContent = msg;
  t.classList.add('show');
  toastTimeout = setTimeout(() => {
    t.classList.remove('show');
    toastTimeout = null;
  }, 2500);
}

// ============ Start ============
init();
