// Servidor del Pixel Shooter: cuentas (HTTP) + salas online, cooperativo y PvP (WebSocket, ver rooms.js).
// Uso: npm install && node server.js   (con DATABASE_URL usa Postgres; si no, data/accounts.json)
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createStore, hashPassword, checkPassword, cleanData, DEFAULT_STATS } = require('./store');
const { createRooms } = require('./rooms');

const PORT = process.env.PORT || 8080;
const NAME_RE = /^[A-Za-z0-9_]{3,12}$/;
// Versión del protocolo: subirla junto con GAME_V del juego cada vez que cambian los mensajes.
// Un juego viejo (por ejemplo, guardado en la caché del navegador) no puede entrar a salas nuevas.
const GAME_V = 3;

(async () => {
  const store = await createStore();
  const SECRET = process.env.TOKEN_SECRET || await store.secret();

  // ---------- tokens firmados (sobreviven a reinicios del servidor)
  const sign = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const issueToken = name => {
    const body = Buffer.from(JSON.stringify({ n: name, e: Date.now() + 30 * 864e5 })).toString('base64url');
    return body + '.' + sign(body);
  };
  const readToken = tok => {
    if (typeof tok !== 'string') return null;
    const [body, sig] = tok.split('.'), good = body && sign(body);
    if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.e > Date.now() ? o.n : null; } catch { return null; }
  };
  const publicUser = u => ({ name: u.name, data: u.data || null, stats: { ...DEFAULT_STATS, ...u.stats } });

  // ---------- API HTTP
  const attempts = new Map();
  const limited = ip => {
    const t = Date.now(), a = (attempts.get(ip) || []).filter(x => t - x < 60000);
    a.push(t); attempts.set(ip, a);
    return a.length > 12;
  };
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(o)); };
  const readBody = req => new Promise(ok => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 32 * 1024) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { ok({}); } });
    req.on('error', () => ok({}));
  });
  const authName = req => readToken(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

  const routes = {
    'GET /': (req, res) => { res.writeHead(200, CORS); res.end('Pixel Shooter server OK'); },
    'GET /health': (req, res) => { res.writeHead(200, CORS); res.end('ok'); },
    // dónde se guardan las cuentas: con persistent=false se borran al reiniciar el servidor
    'GET /api/info': (req, res) => json(res, 200, { storage: store.kind, persistent: store.kind === 'PostgreSQL', v: GAME_V }),
    'POST /api/register': async (req, res, ip) => {
      if (limited(ip)) return json(res, 429, { error: 'Demasiados intentos, esperá un minuto' });
      const { username, password, password2 } = await readBody(req);
      if (typeof username !== 'string' || !NAME_RE.test(username)) return json(res, 400, { error: 'El usuario debe tener de 3 a 12 caracteres (letras, números o _)' });
      if (typeof password !== 'string' || password.length < 4 || password.length > 64) return json(res, 400, { error: 'La contraseña debe tener entre 4 y 64 caracteres' });
      if (password !== password2) return json(res, 400, { error: 'Las contraseñas no coinciden' });
      if (!(await store.createUser({ name: username, ...hashPassword(password) }))) return json(res, 409, { error: 'Ese usuario ya está registrado' });
      console.log('[cuenta] registrada', username);
      json(res, 200, { token: issueToken(username), user: publicUser(await store.getUser(username)) });
    },
    'POST /api/login': async (req, res, ip) => {
      if (limited(ip)) return json(res, 429, { error: 'Demasiados intentos, esperá un minuto' });
      const { username, password } = await readBody(req);
      if (typeof username !== 'string' || typeof password !== 'string') return json(res, 400, { error: 'Faltan datos' });
      const u = await store.getUser(username);
      if (!u || !checkPassword(password, u.salt, u.hash)) return json(res, 401, { error: 'Usuario o contraseña incorrectos' });
      json(res, 200, { token: issueToken(u.name), user: publicUser(u) });
    },
    'GET /api/me': async (req, res) => {
      const name = authName(req);
      if (!name) return json(res, 401, { error: 'Sesión vencida, iniciá sesión de nuevo' });
      const u = await store.getUser(name);
      if (!u) return json(res, 404, { error: 'Tu cuenta ya no existe en el servidor (se reinició sin base de datos). Registrate de nuevo.' });
      json(res, 200, publicUser(u));
    },
    'POST /api/save': async (req, res) => {
      const name = authName(req);
      if (!name) return json(res, 401, { error: 'Sesión vencida, iniciá sesión de nuevo' });
      const data = cleanData((await readBody(req)).data);
      if (!data) return json(res, 400, { error: 'Datos inválidos' });
      await store.updateUser(name, { data });
      json(res, 200, { ok: true });
    },
    'GET /api/top': async (req, res) => {
      json(res, 200, (await store.top(10)).map(u => [u.name, u.stats.rating, u.stats.wins, u.stats.losses]));
    }
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const route = routes[req.method + ' ' + req.url.split('?')[0]];
    if (!route) return json(res, 404, { error: 'No encontrado' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try { await route(req, res, ip); } catch (e) { console.error(e); json(res, 500, { error: 'Error del servidor' }); }
  });

  // ---------- salas por WebSocket (la lógica está en rooms.js, compartida con las partidas locales)
  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  const hub = createRooms({ store, readToken, gameV: GAME_V });
  wss.on('connection', ws => {
    hub.open(ws);
    ws.on('message', raw => hub.message(ws, raw));
    ws.on('close', () => hub.close(ws));
  });

  server.listen(PORT, () => {
    console.log('Servidor escuchando en el puerto', PORT, '· cuentas:', store.kind);
    if (store.kind !== 'PostgreSQL') console.warn('ATENCIÓN: sin DATABASE_URL las cuentas y el ranking se borran cada vez que Render reinicia el servidor.');
  });
})();
