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
const GAME_V = 6;

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
  const authUser = async (req, res) => {
    const name = authName(req), u = name && await store.getUser(name);
    if (!u) json(res, 401, { error: 'Sesión vencida, iniciá sesión de nuevo' });
    return u || null;
  };
  // amigos: lista y solicitudes recibidas guardadas en la cuenta; en línea e invitaciones solo en memoria
  const social = u => { const so = u.social || {}; return { friends: Array.isArray(so.friends) ? so.friends.slice(0, 100) : [], req: Array.isArray(so.req) ? so.req.slice(0, 30) : [] }; };
  const seen = new Map(), invites = new Map();

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
    },

    // ---------- amigos: solicitudes, lista (con quién está en línea) e invitaciones a salas
    'GET /api/friends': async (req, res) => {
      const me = await authUser(req, res); if (!me) return;
      seen.set(me.name.toLowerCase(), Date.now());   // consultar la lista cuenta como estar en línea
      const so = social(me), now = Date.now();
      const friends = await Promise.all(so.friends.map(async n => {
        const u = await store.getUser(n);
        return u ? { name: u.name, online: now - (seen.get(n.toLowerCase()) || 0) < 25000 } : null;
      }));
      const inv = (invites.get(me.name.toLowerCase()) || []).filter(i => now - i.t < 120000);
      invites.delete(me.name.toLowerCase());
      json(res, 200, { friends: friends.filter(Boolean), req: so.req, inv });
    },
    'POST /api/friends/add': async (req, res, ip) => {
      if (limited(ip)) return json(res, 429, { error: 'Demasiados intentos, esperá un minuto' });
      const me = await authUser(req, res); if (!me) return;
      const { name } = await readBody(req), u = typeof name === 'string' && await store.getUser(name);
      if (!u) return json(res, 404, { error: 'No existe ese usuario' });
      if (u.name.toLowerCase() === me.name.toLowerCase()) return json(res, 400, { error: 'No te podés agregar a vos mismo' });
      const a = social(me), b = social(u), has = (l, n) => l.some(x => x.toLowerCase() === n.toLowerCase());
      if (has(a.friends, u.name)) return json(res, 200, { ok: true, msg: 'Ya son amigos' });
      if (has(a.req, u.name)) {   // ya te había mandado solicitud: se hacen amigos directo
        a.req = a.req.filter(x => x.toLowerCase() !== u.name.toLowerCase()); a.friends.push(u.name); b.friends.push(me.name);
        await store.updateUser(me.name, { social: a }); await store.updateUser(u.name, { social: b });
        return json(res, 200, { ok: true, msg: 'Ahora son amigos' });
      }
      if (!has(b.req, me.name)) { b.req.push(me.name); b.req = b.req.slice(-30); await store.updateUser(u.name, { social: b }); }
      json(res, 200, { ok: true, msg: 'Solicitud enviada a ' + u.name });
    },
    'POST /api/friends/accept': async (req, res) => {
      const me = await authUser(req, res); if (!me) return;
      const { name } = await readBody(req), a = social(me);
      if (typeof name !== 'string' || !a.req.some(x => x.toLowerCase() === name.toLowerCase())) return json(res, 404, { error: 'No hay solicitud de ese usuario' });
      const u = await store.getUser(name);
      a.req = a.req.filter(x => x.toLowerCase() !== name.toLowerCase());
      if (u) { const b = social(u); a.friends.push(u.name); b.friends.push(me.name); b.req = b.req.filter(x => x.toLowerCase() !== me.name.toLowerCase()); await store.updateUser(u.name, { social: b }); }
      await store.updateUser(me.name, { social: a });
      json(res, 200, { ok: true });
    },
    'POST /api/friends/remove': async (req, res) => {   // quitar amigo o rechazar solicitud
      const me = await authUser(req, res); if (!me) return;
      const { name } = await readBody(req); if (typeof name !== 'string') return json(res, 400, { error: 'Faltan datos' });
      const lo = name.toLowerCase(), a = social(me), not = x => x.toLowerCase() !== lo;
      a.friends = a.friends.filter(not); a.req = a.req.filter(not);
      await store.updateUser(me.name, { social: a });
      const u = await store.getUser(name);
      if (u) { const b = social(u), n2 = x => x.toLowerCase() !== me.name.toLowerCase(); b.friends = b.friends.filter(n2); await store.updateUser(u.name, { social: b }); }
      json(res, 200, { ok: true });
    },
    'POST /api/friends/invite': async (req, res) => {
      const me = await authUser(req, res); if (!me) return;
      const { name, room, md } = await readBody(req);
      if (typeof name !== 'string' || typeof room !== 'string' || !/^P\|[A-Z0-9]{4,8}$/.test(room)) return json(res, 400, { error: 'Datos inválidos' });
      if (!social(me).friends.some(x => x.toLowerCase() === name.toLowerCase())) return json(res, 403, { error: 'Solo podés invitar a tus amigos' });
      const k = name.toLowerCase(), l = (invites.get(k) || []).filter(i => i.from !== me.name);
      l.push({ from: me.name, room, md: typeof md === 'string' ? md.slice(0, 8) : '', t: Date.now() });
      invites.set(k, l.slice(-5));
      json(res, 200, { ok: true });
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
