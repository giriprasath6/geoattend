'use strict';

const API = '/api';
const state = {
  token: localStorage.getItem('ga_token'),
  user: JSON.parse(localStorage.getItem('ga_user') || 'null'),
  sessionId: null,
  tab: 'login',
  timer: null,
};

const $ = (s) => document.querySelector(s);
const app = $('#app');

async function api(path, opt = {}) {
  const res = await fetch(API + path, {
    method: opt.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.distance = data.distance;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast ' + kind), 3200);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDist = (m) => m == null ? '—' : (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km');
const mmss = (ms) => {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => {
        const msgs = { 1: 'Location permission denied', 2: 'Location unavailable', 3: 'Timeout' };
        reject(new Error(msgs[e.code] || 'Location error'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function setAuth(token, user) {
  state.token = token;
  state.user = user;
  if (token) {
    localStorage.setItem('ga_token', token);
    localStorage.setItem('ga_user', JSON.stringify(user));
  } else {
    localStorage.removeItem('ga_token');
    localStorage.removeItem('ga_user');
  }
}

function showAuth() {
  clearInterval(state.timer);
  app.innerHTML = `
    <div class="wrap" style="max-width:420px;margin-top:40px">
      <h1>📍 GeoAttend</h1>
      <p class="sub">Geo-fenced classroom attendance</p>
      <div class="card">
        <div class="tabs">
          <button class="${state.tab === 'login' ? 'active' : ''}" data-tab="login">Sign in</button>
          <button class="${state.tab === 'register' ? 'active' : ''}" data-tab="register">Create account</button>
        </div>
        <form id="authForm">
          ${state.tab === 'register' ? `
            <label>Full name</label>
            <input name="name" required placeholder="John Doe" />
            <label>I am a</label>
            <select name="role">
              <option value="student">Student</option>
              <option value="teacher">Teacher</option>
            </select>
          ` : ''}
          <label>Email</label>
          <input name="email" type="email" required placeholder="you@school.com" />
          <label>Password</label>
          <input name="password" type="password" required placeholder="••••••••" />
          <button type="submit">${state.tab === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p class="hint">💡 Open in two browsers: one as teacher, one as student.</p>
      </div>
    </div>`;

  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => { state.tab = b.dataset.tab; showAuth(); })
  );

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(e.target));
      const path = state.tab === 'login' ? '/auth/login' : '/auth/register';
      const { token, user } = await api(path, { method: 'POST', body: f });
      setAuth(token, user);
      toast('Welcome, ' + user.name + '!', 'ok');
      route();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });
}

function topbar() {
  return `
    <div class="topbar">
      <div>
        <h1>📍 GeoAttend</h1>
        <p class="sub" style="margin:0">${state.user.role === 'teacher' ? 'Teacher console' : 'Student portal'}</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="badge ${state.user.role === 'teacher' ? '' : 'ok'}">${state.user.role}</span>
        <span style="font-size:14px">${esc(state.user.name)}</span>
        <button class="sm ghost" id="logout">Sign out</button>
      </div>
    </div>`;
}

function bindTopbar() {
  const btn = $('#logout');
  if (btn) btn.addEventListener('click', () => {
    clearInterval(state.timer);
    setAuth(null, null);
    state.sessionId = null;
    route();
  });
}

async function showTeacher() {
  clearInterval(state.timer);
  app.innerHTML = `<div class="wrap">${topbar()}<div id="body"></div></div>`;
  bindTopbar();

  if (state.sessionId) return showRoster();

  const body = $('#body');
  let sessions = [], ip = '—';
  try {
    const [s, i] = await Promise.all([api('/sessions/mine'), api('/my-ip')]);
    sessions = s.sessions; ip = i.ip;
  } catch (err) {
    body.innerHTML = `<div class="card"><div class="empty">${esc(err.message)}</div></div>`;
    return;
  }

  body.innerHTML = `
    <div class="card">
      <h2>Start an attendance session</h2>
      <form id="newSession">
        <div class="row">
          <div><label>Course</label><input name="course" required placeholder="CS-301 Databases" /></div>
          <div><label>Room</label><input name="room" placeholder="Lab 204" /></div>
        </div>
        <div class="row">
          <div><label>Latitude</label><input name="lat" id="lat" type="number" step="any" required placeholder="28.6139" /></div>
          <div><label>Longitude</label><input name="lng" id="lng" type="number" step="any" required placeholder="77.2090" /></div>
        </div>
        <button type="button" class="sm ghost" id="useLoc" style="margin-top:10px">📍 Use my current location</button>
        <div class="row" style="margin-top:14px">
          <div><label>Radius (metres)</label><input name="radius" type="number" min="10" max="2000" value="50" required /></div>
          <div><label>Duration (minutes)</label><input name="duration" type="number" min="1" max="240" value="15" required /></div>
        </div>
        <button type="submit">Open attendance session</button>
      </form>
      <p class="hint">Your server-observed IP: <b>${esc(ip)}</b></p>
    </div>
    <div class="card">
      <h2>My sessions</h2>
      <div id="sessionList">
        ${sessions.length ? sessions.map(sessionCard).join('') : '<div class="empty"><span class="big">🕒</span>No sessions yet. Create one above.</div>'}
      </div>
    </div>`;

  $('#useLoc').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Locating…';
    try {
      const loc = await getLocation();
      $('#lat').value = loc.lat.toFixed(6);
      $('#lng').value = loc.lng.toFixed(6);
      toast(`Location captured (±${loc.accuracy} m)`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
    finally { e.target.disabled = false; e.target.textContent = '📍 Use my current location'; }
  });

  $('#newSession').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(e.target));
      const { session } = await api('/sessions', { method: 'POST', body: data });
      toast(`Session ${session.code} is LIVE`, 'ok');
      state.sessionId = session.id;
      showTeacher();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  });

  bindSessionCards();
  state.timer = setInterval(refreshSessionList, 10000);
}

function bindSessionCards() {
  document.querySelectorAll('[data-open]').forEach((b) =>
    b.addEventListener('click', () => { state.sessionId = b.dataset.open; showTeacher(); })
  );
}

async function refreshSessionList() {
  if (state.sessionId || !$('#sessionList')) return;
  try {
    const { sessions } = await api('/sessions/mine');
    $('#sessionList').innerHTML = sessions.length
      ? sessions.map(sessionCard).join('')
      : '<div class="empty"><span class="big">🕒</span>No sessions yet. Create one above.</div>';
    bindSessionCards();
  } catch {}
}

function sessionCard(s) {
  const pct = s.total ? Math.round((s.present / s.total) * 100) : 0;
  return `
    <div class="item">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:flex-start">
        <div>
          <h3>${esc(s.course)} <span class="badge ${s.isActive ? 'ok' : 'gray'}">${s.isActive ? 'LIVE' : 'closed'}</span></h3>
          <div class="meta">🏫 ${esc(s.room || '—')} · 🔑 <b>${esc(s.code)}</b> · 🕐 ${fmtTime(s.startAt)}–${fmtTime(s.endsAt)}</div>
          <div class="meta">👥 ${s.present}/${s.total} present</div>
        </div>
        <button class="sm ghost" data-open="${s.id}">View roster</button>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
}

async function showRoster() {
  const body = $('#body');
  async function paint() {
    let data;
    try { data = await api('/sessions/' + state.sessionId); }
    catch (err) {
      body.innerHTML = `<div class="card"><div class="empty">${esc(err.message)}<br><br>
        <button class="sm ghost" id="back">← Back</button></div></div>`;
      $('#back').addEventListener('click', () => { state.sessionId = null; showTeacher(); });
      return;
    }
    const { session, records, roster } = data;
    const pct = roster.length ? Math.round((records.length / roster.length) * 100) : 0;

    body.innerHTML = `
      <div class="card">
        <button class="sm ghost" id="back">← All sessions</button>
        <h2 style="margin-top:14px">${esc(session.course)} <span class="badge ${session.isActive ? 'ok' : 'gray'}">${session.isActive ? 'LIVE' : 'closed'}</span></h2>
        <div class="meta">🏫 ${esc(session.room || '—')} · 🔑 <b>${esc(session.code)}</b> · 📐 ${session.radius} m · 🕐 ${fmtDateTime(session.startAt)} → ${fmtTime(session.endsAt)}</div>
        <div class="stat-grid">
          <div class="stat"><b>${records.length}</b><span>Present</span></div>
          <div class="stat"><b>${Math.max(roster.length - records.length, 0)}</b><span>Absent</span></div>
          <div class="stat"><b>${roster.length}</b><span>Enrolled</span></div>
          <div class="stat"><b id="cd">${session.isActive ? mmss(session.endsAt - Date.now()) : '—'}</b><span>Time left</span></div>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        ${session.isActive ? '<button class="sm danger" id="close" style="margin-top:14px">Close session</button>' : ''}
        <table style="margin-top:16px">
          <thead><tr><th>Student</th><th>Status</th><th>Time</th><th>Distance</th><th>IP</th></tr></thead>
          <tbody>
            ${roster.length ? roster.map((s) => {
              const rec = records.find((r) => r.studentId === s.id);
              return `<tr>
                <td><b>${esc(s.name)}</b><br><span style="font-size:12px;color:#667085">${esc(s.email)}</span></td>
                <td>${rec ? '<span class="badge ok">✓ present</span>' : '<span class="badge err">absent</span>'}</td>
                <td>${rec ? fmtTime(rec.markedAt) : '—'}</td>
                <td>${rec ? fmtDist(rec.distance) : '—'}</td>
                <td style="font-size:12px;color:#667085">${rec ? esc(rec.ip) : '—'}</td>
              </tr>`;
            }).join('') : '<tr><td colspan="5" class="empty">No students registered yet.</td></tr>'}
          </tbody>
        </table>
      </div>`;

    $('#back').addEventListener('click', () => { clearInterval(state.timer); state.sessionId = null; showTeacher(); });
    $('#close')?.addEventListener('click', async () => {
      if (!confirm('Close this session?')) return;
      await api('/sessions/' + state.sessionId + '/close', { method: 'POST' });
      toast('Session closed', 'ok');
      paint();
    });
  }
  await paint();
  clearInterval(state.timer);
  state.timer = setInterval(paint, 8000);
}

async function showStudent() {
  clearInterval(state.timer);
  app.innerHTML = `<div class="wrap">${topbar()}<div id="body"></div></div>`;
  bindTopbar();
  await paintStudent();
  state.timer = setInterval(paintStudent, 12000);
}

async function paintStudent() {
  const body = $('#body');
  if (!body) return;

  let live, history, ipInfo;
  try {
    [live, history, ipInfo] = await Promise.all([
      api('/student/sessions'),
      api('/student/attendance'),
      api('/my-ip'),
    ]);
  } catch (err) {
    body.innerHTML = `<div class="card"><div class="empty">${esc(err.message)}</div></div>`;
    return;
  }

  body.innerHTML = `
    <div class="card">
      <h2>Open attendance sessions</h2>
      ${live.sessions.length
        ? live.sessions.map(studentCard).join('')
        : '<div class="empty"><span class="big">🎓</span>No open sessions right now. Your teacher will start one soon.</div>'}
      <p class="hint">Your server-observed IP: <b>${esc(ipInfo.ip)}</b></p>
    </div>
    <div class="card">
      <h2>My attendance history</h2>
      ${history.records.length ? `
        <table>
          <thead><tr><th>Course</th><th>Room</th><th>Date</th><th>Time</th><th>Distance</th></tr></thead>
          <tbody>
            ${history.records.map((r) => `<tr>
              <td><b>${esc(r.course)}</b></td>
              <td>${esc(r.room || '—')}</td>
              <td>${new Date(r.markedAt).toLocaleDateString()}</td>
              <td>${fmtTime(r.markedAt)}</td>
              <td>${fmtDist(r.distance)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No attendance yet.</div>'}
    </div>`;

  document.querySelectorAll('[data-mark]').forEach((b) =>
    b.addEventListener('click', () => markAttendance(b))
  );
}

function studentCard(s) {
  const remaining = s.endsAt - Date.now();
  return `
    <div class="item">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <h3>${esc(s.course)}</h3>
          <div class="meta">🏫 ${esc(s.room || '—')} · 👩‍🏫 ${esc(s.teacherName)}</div>
          <div class="meta">⏳ Closes in ${mmss(remaining)}</div>
        </div>
        <div style="text-align:right">
          ${s.alreadyMarked ? '<span class="badge ok">✓ marked</span>' : '<span class="badge warn">pending</span>'}
        </div>
      </div>
      <div style="margin-top:10px">
        <button class="sm" data-mark="${s.id}" ${s.alreadyMarked ? 'disabled' : ''}>
          ${s.alreadyMarked ? 'Attendance recorded' : '📍 Mark my attendance'}
        </button>
      </div>
      <p class="hint" id="status-${s.id}">You must be within ${s.radius} m of the classroom.</p>
    </div>`;
}

async function markAttendance(btn) {
  const id = btn.dataset.mark;
  const status = document.getElementById('status-' + id);
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Getting location…';
  if (status) status.textContent = 'Requesting GPS fix…';

  try {
    const loc = await getLocation();
    if (status) status.textContent = `Acquired (±${loc.accuracy} m). Verifying…`;
    btn.textContent = 'Verifying…';
    const r = await api('/attendance', {
      method: 'POST',
      body: { sessionId: id, lat: loc.lat, lng: loc.lng },
    });
    toast(`Attendance marked — ${fmtDist(r.distance)} from classroom`, 'ok');
    await paintStudent();
  } catch (err) {
    const extra = err.distance != null ? ` (${fmtDist(err.distance)} away)` : '';
    toast(err.message + extra, 'err');
    if (status) status.textContent = err.message + extra;
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function route() {
  if (!state.token || !state.user) return showAuth();
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    localStorage.setItem('ga_user', JSON.stringify(user));
  } catch {
    setAuth(null, null);
    return showAuth();
  }
  return state.user.role === 'teacher' ? showTeacher() : showStudent();
}

route();