import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'geoattend-secret';

app.use(express.json());
app.set('trust proxy', true);
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: [], sessions: [], records: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

const sign = (uid) => {
  const p = Buffer.from(JSON.stringify({ uid })).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return `${p}.${s}`;
};

const verify = (t) => {
  if (!t || !t.includes('.')) return null;
  const [p, s] = t.split('.');
  if (s !== crypto.createHmac('sha256', SECRET).update(p).digest('base64url')) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
};

const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const d = verify(t);
  const u = d && db.users.find(x => x.id === d.uid);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  req.user = u;
  next();
};

const clientIp = (req) => {
  const raw = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim();
  return raw.replace(/^::ffff:/, '');
};

const haversine = (lat1, lng1, lat2, lng2) => {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const clean = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Fill all fields' });
  if (!['student', 'teacher'].includes(role)) return res.status(400).json({ error: 'Pick a role' });
  if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(400).json({ error: 'Email already registered' });
  const u = { id: crypto.randomUUID(), name, email, role, password: hash(password) };
  db.users.push(u); save();
  res.json({ token: sign(u.id), user: clean(u) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.users.find(x => x.email.toLowerCase() === String(email).toLowerCase());
  if (!u || u.password !== hash(password))
    return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(u.id), user: clean(u) });
});

app.get('/api/auth/me', auth, (req, res) => res.json({ user: clean(req.user) }));
app.get('/api/my-ip', (req, res) => res.json({ ip: clientIp(req) }));

const summarise = (s) => ({
  id: s.id, course: s.course, room: s.room, code: s.code,
  startAt: s.startAt, endsAt: s.endsAt, radius: s.radius,
  isActive: !s.closed && Date.now() < s.endsAt,
  present: db.records.filter(r => r.sessionId === s.id).length,
  total: db.users.filter(u => u.role === 'student').length,
});

app.post('/api/sessions', auth, (req, res) => {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teachers only' });
  const { course, room, lat, lng, radius, duration } = req.body || {};
  if (!course || lat == null || lng == null)
    return res.status(400).json({ error: 'Course and location required' });
  const now = Date.now();
  const s = {
    id: crypto.randomUUID(), teacherId: req.user.id, teacherName: req.user.name,
    code: crypto.randomBytes(3).toString('hex').toUpperCase(),
    course, room: room || '', lat: Number(lat), lng: Number(lng),
    radius: Math.min(Math.max(Number(radius) || 50, 10), 2000),
    startAt: now,
    endsAt: now + Math.min(Math.max(Number(duration) || 15, 1), 240) * 60000,
    closed: false,
  };
  db.sessions.push(s); save();
  res.json({ session: summarise(s) });
});

app.get('/api/sessions/mine', auth, (req, res) => {
  res.json({ sessions: db.sessions.filter(s => s.teacherId === req.user.id).sort((a,b) => b.startAt - a.startAt).map(summarise) });
});

app.get('/api/sessions/:id', auth, (req, res) => {
  const s = db.sessions.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({
    session: summarise(s),
    records: db.records.filter(r => r.sessionId === s.id),
    roster: db.users.filter(u => u.role === 'student').map(clean),
  });
});

app.post('/api/sessions/:id/close', auth, (req, res) => {
  const s = db.sessions.find(x => x.id === req.params.id && x.teacherId === req.user.id);
  if (s) { s.closed = true; save(); }
  res.json({ ok: true });
});

app.get('/api/student/sessions', auth, (req, res) => {
  const now = Date.now();
  res.json({ sessions: db.sessions.filter(s => !s.closed && now < s.endsAt).map(s => ({
    id: s.id, course: s.course, room: s.room, teacherName: s.teacherName,
    radius: s.radius, endsAt: s.endsAt,
    alreadyMarked: db.records.some(r => r.sessionId === s.id && r.studentId === req.user.id),
  })) });
});

app.get('/api/student/attendance', auth, (req, res) => {
  res.json({ records: db.records.filter(r => r.studentId === req.user.id).map(r => {
    const s = db.sessions.find(x => x.id === r.sessionId) || {};
    return { course: s.course, room: s.room, markedAt: r.markedAt, distance: r.distance };
  }) });
});

app.post('/api/attendance', auth, (req, res) => {
  const { sessionId, lat, lng } = req.body || {};
  const s = db.sessions.find(x => x.id === sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.closed || Date.now() > s.endsAt) return res.status(410).json({ error: 'Session closed' });
  if (lat == null || lng == null) return res.status(400).json({ error: 'Location required' });
  const d = haversine(s.lat, s.lng, Number(lat), Number(lng));
  if (d > s.radius) return res.status(403).json({ error: 'You are outside the classroom geo-fence', distance: d });
  if (db.records.some(r => r.sessionId === s.id && r.studentId === req.user.id))
    return res.status(409).json({ error: 'Already marked' });
  db.records.push({
    sessionId: s.id, studentId: req.user.id, studentName: req.user.name,
    markedAt: Date.now(), lat: Number(lat), lng: Number(lng), distance: d, ip: clientIp(req),
  });
  save();
  res.json({ ok: true, distance: d });
});

app.listen(PORT, '0.0.0.0', () => console.log(`\n✅ Open http://localhost:${PORT}\n`));