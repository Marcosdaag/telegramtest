// ============ Telegram WebApp Init ============
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

let currentUser = null;
let bonusInterval = null;
let CFG = {};

// ============ Init ============
async function init() {
  // Cargar configuración del backend
  try {
    const cfgRes = await fetch('/api/config');
    CFG = await cfgRes.json();
  } catch (e) {
    CFG = { bonus_amount: 5, bonus_cooldown_ms: 3600000, referral_bonus: 10, min_withdrawal: 10 };
  }

  const tgUser = tg?.initDataUnsafe?.user || {
    id: 123456789,
    first_name: 'Test',
    last_name: 'User',
    username: 'testuser',
    photo_url: ''
  };

  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref') || tg?.initDataUnsafe?.start_param || null;

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: tgUser, ref })
    });
    currentUser = await res.json();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    render();
  } catch (e) {
    document.getElementById('loading').innerHTML = '<p style="color:#ff4466">Error de conexión</p>';
  }
}

// ============ Render ============
function render() {
  const u = currentUser;
  const initial = (u.first_name || 'U')[0].toUpperCase();
  const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Usuario';

  const avatarHTML = u.photo_url
    ? `<img class="avatar" src="${u.photo_url}" alt="avatar">`
    : `<div class="avatar-placeholder">${initial}</div>`;

  document.getElementById('app').innerHTML = `
    <div class="fade-in">
      <!-- Perfil -->
      <div class="profile-header">
        ${avatarHTML}
        <div class="user-name">${esc(fullName)}</div>
        ${u.username ? `<div class="user-handle">@${esc(u.username)}</div>` : ''}
      </div>

      <!-- Balance -->
      <div class="balance-card">
        <div class="balance-label">Tu Balance</div>
        <div class="balance-value">${Number(u.balance).toFixed(2)} <span>TOK</span></div>
      </div>

      <!-- Bonus -->
      <div class="card">
        <div class="card-title">⚡ Bonus Cada Hora</div>
        <button id="bonusBtn" class="bonus-btn" onclick="claimBonus()"></button>
      </div>

      <!-- Referidos -->
      <div class="card">
        <div class="card-title">👥 Enlace de Afiliado</div>
        <div class="ref-link-box">
          <input type="text" id="refInput" value="${esc(u.referral_link)}" readonly>
          <button class="copy-btn" onclick="copyRef()">Copiar</button>
        </div>
        <div class="ref-stats">
          <div class="ref-stat">
            <div class="ref-stat-val">${u.referral_count || 0}</div>
            <div class="ref-stat-lbl">Referidos</div>
          </div>
          <div class="ref-stat">
            <div class="ref-stat-val">+${CFG.referral_bonus}</div>
            <div class="ref-stat-lbl">TOK por ref.</div>
          </div>
        </div>
      </div>

      <!-- Retiro -->
      <div class="card">
        <div class="card-title">💸 Solicitar Retiro</div>
        <div class="min-note">Mínimo: ${CFG.min_withdrawal} TOK · Disponible: ${Number(u.balance).toFixed(2)} TOK</div>
        <input id="withdrawAmount" class="withdraw-input" type="number" placeholder="Cantidad en TOK" min="${CFG.min_withdrawal}" step="0.01">
        <button class="withdraw-btn" onclick="withdraw()">Solicitar Retiro</button>
      </div>

      <!-- Historial -->
      <div class="card">
        <div class="card-title">📋 Historial de Retiros</div>
        <div id="history"><div class="empty">Cargando...</div></div>
      </div>
    </div>
  `;

  updateBonusBtn();
  if (bonusInterval) clearInterval(bonusInterval);
  bonusInterval = setInterval(updateBonusBtn, 1000);
  loadHistory();
}

// ============ Bonus ============
function updateBonusBtn() {
  const btn = document.getElementById('bonusBtn');
  if (!btn) return;

  const last = currentUser.last_bonus || 0;
  const now = Date.now();
  const diff = now - last;
  const cooldown = CFG.bonus_cooldown_ms;

  if (diff >= cooldown) {
    btn.className = 'bonus-btn active';
    btn.innerHTML = `🎁 Reclamar +${CFG.bonus_amount} TOK`;
  } else {
    btn.className = 'bonus-btn cooldown';
    const remaining = cooldown - diff;
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    btn.innerHTML = `Próximo bonus en<span class="bonus-timer">${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}</span>`;
  }
}

async function claimBonus() {
  const btn = document.getElementById('bonusBtn');
  if (!btn || btn.classList.contains('cooldown')) return;

  try {
    const res = await fetch('/api/bonus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: currentUser.telegram_id })
    });
    const data = await res.json();

    if (data.success) {
      currentUser.balance = data.balance;
      currentUser.last_bonus = Date.now();
      toast(`🎉 +${CFG.bonus_amount} TOK reclamados!`);
      render();
    } else {
      currentUser.last_bonus = Date.now() - (CFG.bonus_cooldown_ms - data.remaining);
      updateBonusBtn();
    }
  } catch (e) {
    toast('Error al reclamar');
  }
}

// ============ Withdraw ============
async function withdraw() {
  const input = document.getElementById('withdrawAmount');
  const amount = parseFloat(input.value);

  if (!amount || amount < CFG.min_withdrawal) {
    toast(`Mínimo ${CFG.min_withdrawal} TOK`);
    return;
  }
  if (amount > currentUser.balance) {
    toast('Saldo insuficiente');
    return;
  }

  try {
    const res = await fetch('/api/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: currentUser.telegram_id, amount })
    });
    const data = await res.json();

    if (data.success) {
      currentUser.balance = data.balance;
      toast(`✅ Retiro solicitado: ${amount} TOK`);
      render();
    } else {
      toast(data.message || 'Error');
    }
  } catch (e) {
    toast('Error al solicitar retiro');
  }
}

// ============ History ============
async function loadHistory() {
  try {
    const res = await fetch('/api/withdrawals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: currentUser.telegram_id })
    });
    const data = await res.json();
    const el = document.getElementById('history');

    if (!data.length) {
      el.innerHTML = '<div class="empty">Sin retiros aún</div>';
      return;
    }

    el.innerHTML = data.map(w => `
      <div class="history-item">
        <div>
          <div class="h-amount">-${Number(w.amount).toFixed(2)} TOK</div>
          <div class="h-date">${new Date(w.created_at).toLocaleDateString('es')}</div>
        </div>
        <span class="h-status ${w.status}">${w.status === 'pending' ? 'Pendiente' : 'Completado'}</span>
      </div>
    `).join('');
  } catch (e) { /* silenciar */ }
}

// ============ Utils ============
function copyRef() {
  const input = document.getElementById('refInput');
  navigator.clipboard.writeText(input.value).then(() => toast('📋 Enlace copiado!'));
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ============ Start ============
init();
