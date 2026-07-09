// === Common Utilities for Carpark Management System ===

// Check authentication on every page load
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/login.html';
      return null;
    }
    const user = await res.json();
    // Update navbar user display
    const userEl = document.getElementById('nav-user-name');
    if (userEl) userEl.textContent = user.name;
    const roleEl = document.getElementById('nav-user-role');
    if (roleEl) roleEl.textContent = user.role;
    // Hide admin links for non-admin
    if (user.role !== 'admin') {
      document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    }
    return user;
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
}

// API fetch wrapper
async function apiFetch(url, options = {}) {
  const defaults = {
    headers: { 'Content-Type': 'application/json' },
    ...options
  };
  const res = await fetch(url, defaults);
  if (res.status === 401) {
    window.location.href = '/login.html';
    return null;
  }
  return res;
}

// Show alert/toast notification
function showAlert(message, type = 'success', duration = 3500) {
  const container = document.getElementById('alert-container') || (() => {
    const el = document.createElement('div');
    el.id = 'alert-container';
    el.className = 'alert-banner';
    document.body.appendChild(el);
    return el;
  })();

  const alert = document.createElement('div');
  alert.className = `alert alert-${type} alert-dismissible fade show shadow mb-2`;
  alert.innerHTML = `
    ${message}
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;
  container.appendChild(alert);

  setTimeout(() => {
    if (alert.parentNode) alert.parentNode.removeChild(alert);
  }, duration);
}

// Format currency
function formatCurrency(amount) {
  return '$' + parseFloat(amount || 0).toFixed(2);
}

// Format date for display
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Format short date
function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const day = d.getDate();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const year = String(d.getFullYear()).slice(2);
  return `${day}-${months[d.getMonth()]}-${year}`;
}

// Get today's date in YYYY-MM-DD (uses LOCAL time so NZ timezone is correct)
function today() {
  return localDateStr(new Date());
}

// Convert a Date object to YYYY-MM-DD using LOCAL time (not UTC)
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parse a YYYY-MM-DD string and add/subtract days, returning YYYY-MM-DD (local)
function addDays(dateStr, n) {
  const parts = dateStr.split('-');
  const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

// Get status badge HTML
function statusBadge(status) {
  const map = {
    'Eftpos': 'badge-eftpos',
    'Cash': 'badge-cash',
    'Internet Banking': 'badge bg-primary-subtle text-primary-emphasis',
    'OnAcc': 'badge-onaccount',
    'Customer Credit': 'badge bg-success-subtle text-success-emphasis',
    'To Pay': 'badge-topay',
    'Voided': 'badge-voided'
  };
  const cls = map[status] || 'bg-secondary text-white';
  return `<span class="status-badge ${cls}">${status || 'N/A'}</span>`;
}

// Get row class based on payment status
function rowClass(status) {
  const map = {
    'Eftpos': 'row-eftpos',
    'Cash': 'row-cash',
    'Internet Banking': 'row-internet-banking',
    'OnAcc': 'row-onaccount',
    'To Pay': 'row-topay',
    'Voided': 'row-voided'
  };
  return map[status] || '';
}

// Logout
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

// Calculate nights/days between two dates
// Pricing is per 24 hours, so the next calendar day should be 1 day (not 2).
function calcNights(dateIn, dateOut) {
  if (!dateIn || !dateOut) return 0;
  const [y1, m1, day1] = dateIn.split('-').map(Number);
  const [y2, m2, day2] = dateOut.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, day1);
  const t2 = Date.UTC(y2, m2 - 1, day2);
  const diffDays = Math.round((t2 - t1) / (1000 * 60 * 60 * 24));
  // Keep a minimum charge of 1 day when dates are provided.
  return diffDays <= 0 ? 1 : diffDays;
}

function normalizeTimeString(raw) {
  let s = String(raw || '').trim().replace(/\u202f/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  // "11:41:00" / "11:41:00 am" (browsers/DB often add seconds)
  s = s.replace(/^(\d{1,2}):(\d{2}):\d{2}/, '$1:$2');
  // "9:55 a.m." -> "9:55 am"
  s = s.replace(/([ap])\.?\s*m\.?$/i, '$1m');
  return s.trim();
}

function parseClockToHm(input) {
  const s = normalizeTimeString(input);
  // Accept:
  // - "15:53" / "15:53:00"
  // - "3:53 pm" / "03:53pm" / "11:41 am"
  // - "12:00 am" / "12:00 pm"
  const m = s.match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = (m[3] || '').toLowerCase();
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (mm < 0 || mm > 59) return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    if (ap === 'am') hh = (hh === 12) ? 0 : hh;
    if (ap === 'pm') hh = (hh === 12) ? 12 : (hh + 12);
  } else {
    if (hh < 0 || hh > 23) return null;
  }
  return { hh, mm };
}

// True 24-hour billing when times are provided.
// - If both times exist, charge = ceil(diffMs / 24h), min 1
// - If times missing, fall back to date-based calcNights
function calcNights24h(dateIn, timeIn, dateOut, timeOut) {
  if (!dateIn || !dateOut) return 0;
  const tIn = parseClockToHm(timeIn);
  const tOut = parseClockToHm(timeOut);
  if (!tIn || !tOut) return calcNights(dateIn, dateOut);
  const [y1, m1, d1] = String(dateIn).slice(0, 10).split('-').map(Number);
  const [y2, m2, d2] = String(dateOut).slice(0, 10).split('-').map(Number);
  if (![y1, m1, d1, y2, m2, d2].every(Number.isFinite)) return calcNights(dateIn, dateOut);
  const t1 = Date.UTC(y1, m1 - 1, d1, tIn.hh, tIn.mm);
  const t2 = Date.UTC(y2, m2 - 1, d2, tOut.hh, tOut.mm);
  const diffMs = t2 - t1;
  if (diffMs <= 0) return 1;
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs <= dayMs) return 1;
  return Math.max(1, Math.ceil(diffMs / dayMs));
}

// Get month name
function monthName(num) {
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return names[parseInt(num) - 1] || '';
}

// Update cars in yard count in navbar
async function updateNavCarsCount() {
  try {
    const res = await fetch('/api/dashboard/stats', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById('nav-cars-count');
      if (el) el.textContent = `${data.carsInYard} Cars`;
    }
  } catch(e) {}
}

// Debounce
function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Shared navigation HTML
function renderNavbar(activePage) {
  const navItems = [
    { href: '/menu.html', label: 'Menu', icon: 'bi-house-fill', key: 'menu' },
    { href: '/invoice.html', label: 'Invoice', icon: 'bi-receipt', key: 'invoice' },
    { href: '/invoices.html', label: 'Invoices', icon: 'bi-journal-text', key: 'invoices' },
    { href: '/returns.html', label: 'Returns', icon: 'bi-car-front', key: 'returns' },
    { href: '/longterm.html', label: 'Long Term', icon: 'bi-calendar-check', key: 'longterm' },
    { href: '/accounts.html', label: 'Accounts', icon: 'bi-building', key: 'accounts' },
    { href: '/keybox.html', label: 'Key Box', icon: 'bi-key', key: 'keybox' },
    { href: '/reports.html', label: 'Reports', icon: 'bi-bar-chart', key: 'reports' },
    { href: '/banking.html', label: 'Banking', icon: 'bi-bank', key: 'banking' },
    { href: '/endday.html', label: 'End Day', icon: 'bi-calendar-check-fill', key: 'endday' },
    { href: '/email.html', label: 'Emails', icon: 'bi-envelope', key: 'email' },
    { href: '/admin.html', label: 'Admin', icon: 'bi-gear', key: 'admin', adminOnly: true }
  ];

  const links = navItems.map(item => `
    <li class="nav-item${item.adminOnly ? ' admin-only' : ''}">
      <a class="nav-link${activePage === item.key ? ' active' : ''}" href="${item.href}">
        <i class="bi ${item.icon}"></i> ${item.label}
      </a>
    </li>
  `).join('');

  return `
    <nav class="navbar navbar-expand-lg navbar-dark">
      <div class="container-fluid">
        <a class="navbar-brand" href="/menu.html">
          <i class="bi bi-p-square-fill"></i> CAR STORAGE
        </a>
        <div class="d-flex align-items-center gap-2 me-2">
          <span class="navbar-cars-count" id="nav-cars-count">-- Cars</span>
        </div>
        <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navMenu">
          <span class="navbar-toggler-icon"></span>
        </button>
        <div class="collapse navbar-collapse" id="navMenu">
          <ul class="navbar-nav me-auto flex-wrap">
            ${links}
          </ul>
          <div class="d-flex align-items-center gap-2">
            <span class="text-white-50 small">
              <i class="bi bi-person-circle"></i>
              <span id="nav-user-name">User</span>
              <small class="ms-1 text-warning" id="nav-user-role"></small>
            </span>
            <button class="btn btn-sm btn-outline-light" onclick="logout()">
              <i class="bi bi-box-arrow-right"></i>
            </button>
          </div>
        </div>
      </div>
    </nav>
  `;
}

// ─── HTML escaping ──────────────────────────────────────────────────────────
// Any customer/staff-entered free text (names, notes, references, company
// names, etc.) MUST be passed through this before being placed inside an
// innerHTML template string. Without it, a name or note containing HTML/
// script tags would render/execute in every other staff member's browser
// the next time that record is displayed — a stored XSS hole.
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
