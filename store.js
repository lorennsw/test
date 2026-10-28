// Almacenamiento de cuentas. Usa Postgres si existe DATABASE_URL; si no, un archivo JSON
// (en Render gratis el disco es efímero: sin base de datos las cuentas se pierden al reiniciar).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STATS = { rating: 1000, wins: 0, losses: 0, kills: 0, deaths: 0, matches: 0 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64), ref = Buffer.from(hash, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(h, ref);
}

// Progreso que el juego sube a la cuenta: solo campos conocidos y con tipos correctos
const nums = (a, max) => Array.isArray(a) ? [...new Set(a.filter(n => Number.isInteger(n) && n >= 0 && n < max))] : [];
const int = (v, d, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi ? v : d;
function cleanData(d) {
  if (!d || typeof d !== 'object') return null;
  const av = d.av && typeof d.av === 'object' ? d.av : {};
  const str = (v, re) => typeof v === 'string' && re.test(v) ? v : undefined;
  const col = v => str(v, /^#[0-9a-f]{6}$/i);
  return {
    coins: int(d.coins, 0, 0, 1e7), owned: nums(d.owned, 16), eq: int(d.eq, 0, 0, 15),
    arm: int(d.arm, -1, -1, 15), armo: nums(d.armo, 16), pet: int(d.pet, -1, -1, 15), peto: nums(d.peto, 16),
    bestDung: int(d.bestDung, 1, 1, 999), bestKills: int(d.bestKills, 0, 0, 1e7),
    gems: int(d.gems, 0, 0, 1e6), acco: nums(d.acco, 21),
    av: { skin: col(av.skin), hair: col(av.hair), shirt: col(av.shirt), ec: col(av.ec), pn: col(av.pn),
      hs: int(av.hs, 0, 0, 20), os: int(av.os, 0, 0, 20), acc: int(av.acc, 0, 0, 20) }
  };
}

class JsonStore {
  constructor(file) {
    this.file = file;
    this.db = { secret: null, users: {} };
    try { Object.assign(this.db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* archivo nuevo */ }
  }
  async init() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      fs.writeFile(this.file + '.tmp', JSON.stringify(this.db), err => { if (!err) fs.rename(this.file + '.tmp', this.file, () => {}); });
    }, 500);
  }
  async secret() {
    if (!this.db.secret) { this.db.secret = crypto.randomBytes(32).toString('hex'); this.save(); }
    return this.db.secret;
  }
  async getUser(name) { return this.db.users[String(name).toLowerCase()] || null; }
  async createUser(u) {
    const key = u.name.toLowerCase();
    if (this.db.users[key]) return false;
    this.db.users[key] = { ...u, data: null, stats: { ...DEFAULT_STATS }, created: Date.now() };
    this.save();
    return true;
  }
  async updateUser(name, fields) {
    const u = this.db.users[String(name).toLowerCase()];
    if (u) { Object.assign(u, fields); this.save(); }
  }
  async top(n) {
    return Object.values(this.db.users).filter(u => u.stats.matches > 0)
      .sort((a, b) => b.stats.rating - a.stats.rating).slice(0, n);
  }
  get kind() { return 'archivo JSON (efímero en Render)'; }
}

class PgStore {
  constructor(url) { this.url = url; }
  async init() {
    const { Pool } = require('pg');
    // sin TLS en local o con la URL interna de Render (host sin dominio)
    const local = /localhost|127\.0\.0\.1/.test(this.url) || !/\.[a-z]{2,}(:\d+)?\//i.test(this.url);
    this.pool = new Pool({ connectionString: this.url, ssl: local ? false : { rejectUnauthorized: true }, max: 5 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ps_users (
      name_lower TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
      data JSONB, stats JSONB NOT NULL DEFAULT '{}', created BIGINT NOT NULL)`);
    await this.pool.query('CREATE TABLE IF NOT EXISTS ps_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    await this.pool.query('ALTER TABLE ps_users ADD COLUMN IF NOT EXISTS social JSONB');   // amigos y solicitudes
  }
  async secret() {
    await this.pool.query('INSERT INTO ps_meta (k, v) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['secret', crypto.randomBytes(32).toString('hex')]);
    return (await this.pool.query('SELECT v FROM ps_meta WHERE k = $1', ['secret'])).rows[0].v;
  }
  row(r) { return r ? { name: r.name, salt: r.salt, hash: r.hash, data: r.data, stats: { ...DEFAULT_STATS, ...r.stats }, social: r.social || null, created: +r.created } : null; }
  async getUser(name) {
    return this.row((await this.pool.query('SELECT * FROM ps_users WHERE name_lower = $1', [String(name).toLowerCase()])).rows[0]);
  }
  async createUser(u) {
    const res = await this.pool.query(
      'INSERT INTO ps_users (name_lower, name, salt, hash, stats, created) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [u.name.toLowerCase(), u.name, u.salt, u.hash, DEFAULT_STATS, Date.now()]);
    return res.rowCount === 1;
  }
  async updateUser(name, fields) {
    if ('data' in fields) await this.pool.query('UPDATE ps_users SET data = $2 WHERE name_lower = $1', [String(name).toLowerCase(), fields.data]);
    if ('stats' in fields) await this.pool.query('UPDATE ps_users SET stats = $2 WHERE name_lower = $1', [String(name).toLowerCase(), fields.stats]);
    if ('social' in fields) await this.pool.query('UPDATE ps_users SET social = $2 WHERE name_lower = $1', [String(name).toLowerCase(), fields.social]);
  }
  async top(n) {
    const { rows } = await this.pool.query(`SELECT * FROM ps_users WHERE (stats->>'matches')::int > 0 ORDER BY (stats->>'rating')::int DESC LIMIT $1`, [n]);
    return rows.map(r => this.row(r));
  }
  get kind() { return 'PostgreSQL'; }
}

async function createStore() {
  const store = process.env.DATABASE_URL
    ? new PgStore(process.env.DATABASE_URL)
    : new JsonStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'accounts.json'));
  await store.init();
  return store;
}

module.exports = { createStore, hashPassword, checkPassword, cleanData, DEFAULT_STATS };
