// Servidor del Pixel Shooter: cuentas (HTTP) + salas, cooperativo y duelos 1v1 (WebSocket).
// Uso: npm install && node server.js   (con DATABASE_URL usa Postgres; si no, data/accounts.json)
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createStore, hashPassword, checkPassword, cleanData, DEFAULT_STATS } = require('./store');

const PORT = process.env.PORT || 8080;
const MAX = 4;                                        // jugadores por sala si el cliente no elige
const MIN_P = 2, TOP_P = 8;                           // límites para la cantidad elegida
const DEFAULT_ROOMS = ['Sala 1', 'Sala 2', 'Sala 3']; // salas que siempre aparecen en la lista
const WIN_ROUNDS = 3;                                 // duelo al mejor de 5
const DUEL_MAPS = 6;                                  // mapas del duelo (el cliente los dibuja)
const FFA_KILLS = 10;
const WEAPONS = 8, VETO_S = 12, ROULETTE_MS = 5800;   // veto de armas: 12 s por turno, empieza al terminar la ruleta                                 // todos contra todos: gana el primero en llegar
const NAME_RE = /^[A-Za-z0-9_]{3,12}$/;
// Versión del protocolo: subirla junto con GAME_V del juego cada vez que cambian los mensajes.
// Un juego viejo (por ejemplo, guardado en la caché del navegador) no puede entrar a salas nuevas.
const GAME_V = 2;

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

  // ---------- salas por WebSocket
  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
  const rooms = {};
  let nextId = 1, duelN = 1;
  const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const list = () => [...new Set([...DEFAULT_ROOMS, ...Object.keys(rooms).filter(n => !n.includes('|#'))])]
    .map(n => [n, rooms[n] ? rooms[n].size : 0, rooms[n] ? rooms[n].max : MAX]);
  const nameOf = ws => ws.user || ws.nick || 'Jugador';

  // Salas PvP según el prefijo del nombre: V| 1v1, W| 2v2, F| todos contra todos
  const PV = { 'V|': { md: '1v1', max: 2 }, 'W|': { md: '2v2', max: 4 }, 'F|': { md: 'ffa', max: 8 } };
  const QNEED = { '1v1': 2, '2v2': 4, ffa: 6 };
  const pvOf = name => PV[name.slice(0, 2)];

  function joinRoom(ws, name, max) {
    const pv = pvOf(name);
    // el que crea la sala elige cuántos jugadores entran (las salas PvP tienen tamaño fijo)
    const r = rooms[name] || Object.assign(new Set(), { max: pv ? pv.max : Math.max(MIN_P, Math.min(TOP_P, max | 0 || MAX)) });
    if (r.size >= r.max || (r.duel && r.duel.live)) return send(ws, { t: 'full' });
    if (pv && !r.duel) { r.pv = pv; r.duel = { live: false }; }
    rooms[name] = r;
    ws.room = name;
    ws.host = r.size === 0;                         // el primero es el anfitrión (maneja los enemigos)
    r.add(ws);
    send(ws, { t: 'welcome', id: ws.id, host: ws.host, max: r.max });
    if (pv) {
      if (pv.md !== 'ffa' && r.size === r.max) duelStart(r);
      else duelRoomInfo(r);
    }
  }

  // ---------- PvP: el servidor lleva el marcador, arma los equipos y actualiza el rating
  const duelBroadcast = (r, o) => r.forEach(x => send(x, o));
  const duelRoomInfo = r => duelBroadcast(r, { t: 'duel_room', n: r.size, max: r.max, host: ([...r].find(x => x.host) || {}).id });
  async function duelStart(r) {
    const md = r.pv.md, ps = [...r].sort(() => Math.random() - .5);   // equipos al azar
    // el servidor sortea el mapa (distinto al anterior en una revancha) para que todos vean el mismo
    let mp = Math.floor(Math.random() * DUEL_MAPS);
    if (mp === r.lastMp) mp = (mp + 1 + Math.floor(Math.random() * (DUEL_MAPS - 1))) % DUEL_MAPS;
    r.lastMp = mp;
    ps.forEach((x, i) => { x.team = md === 'ffa' ? i : (i < ps.length / 2 ? 0 : 1); x.again = false; x.deadN = 0; });
    r.duel = { live: true, md, n: 1, all: ps, k: {}, de: {}, sc: md === 'ffa' ? Object.fromEntries(ps.map(x => [x.id, 0])) : { 0: 0, 1: 0 } };
    const info = await Promise.all(ps.map(async x => {
      const u = x.user && await store.getUser(x.user);
      return [x.id, nameOf(x), u ? u.stats.rating : null, x.team];
    }));
    duelBroadcast(r, { t: 'duel_start', p: info, n: 1, md, win: md === 'ffa' ? FFA_KILLS : WIN_ROUNDS, mp });
    // veto: el turno pasa por todos alternando equipos (A1, B1, A2, B2…) hasta que queda un arma
    const order = md === 'ffa' ? ps.map(x => x.id)
      : [].concat(...ps.filter(x => x.team === 0).map((x, i) => [x.id, (ps.filter(y => y.team === 1)[i] || {}).id])).filter(Boolean);
    r.duel.veto = { left: [...Array(WEAPONS).keys()], order, i: 0, log: [] };
    clearTimeout(r.vetoT);
    r.vetoT = setTimeout(() => vetoTurn(r), ROULETTE_MS);
  }
  // turno del veto: avisa a todos de quién es; si no elige a tiempo (o se fue), se veta un arma al azar
  function vetoTurn(r) {
    const d = r.duel, v = d && d.veto;
    if (!d || !d.live || !v || v.done) return;
    const ids = new Set([...r].map(x => x.id));
    let tries = v.order.length;
    while (!ids.has(v.order[v.i % v.order.length]) && tries--) v.i++;
    v.turn = v.order[v.i % v.order.length];
    duelBroadcast(r, { t: 'veto_st', left: v.left, turn: v.turn, log: v.log, dl: VETO_S });
    clearTimeout(r.vetoT);
    r.vetoT = setTimeout(() => doVeto(r, v.turn, v.left[Math.floor(Math.random() * v.left.length)], true), VETO_S * 1000);
  }
  function doVeto(r, id, w, auto) {
    const d = r.duel, v = d && d.veto;
    if (!d || !d.live || !v || v.done || id !== v.turn || !v.left.includes(w)) return;
    v.left = v.left.filter(x => x !== w);
    v.log.push([id, w, auto ? 1 : 0]);
    v.i++;
    if (v.left.length > 1) return vetoTurn(r);
    v.done = true;
    clearTimeout(r.vetoT);
    duelBroadcast(r, { t: 'veto_done', w: v.left[0], log: v.log });
  }
  function duelDeath(r, ws, kid) {
    const d = r.duel;
    if (!d.live) return;
    const killer = [...r].find(x => x.id === kid && x !== ws && (d.md === 'ffa' || x.team !== ws.team));
    if (d.md === 'ffa') {
      d.de[ws.id] = (d.de[ws.id] || 0) + 1;
      if (killer) d.sc[killer.id]++;
      duelBroadcast(r, { t: 'duel_kill', k: killer ? killer.id : 0, v: ws.id, sc: d.sc });
      if (killer && d.sc[killer.id] >= FFA_KILLS) duelEnd(r, killer.id, false);
      return;
    }
    if (ws.deadN === d.n) return;                    // una muerte por ronda
    ws.deadN = d.n;
    d.de[ws.id] = (d.de[ws.id] || 0) + 1;
    if (killer) d.k[killer.id] = (d.k[killer.id] || 0) + 1;
    if ([...r].some(x => x.team === ws.team && x.deadN !== d.n)) return;   // queda alguien vivo en su equipo
    const wt = 1 - ws.team;
    d.sc[wt]++;
    if (d.sc[wt] >= WIN_ROUNDS) return duelEnd(r, wt, false);
    d.n++;
    duelBroadcast(r, { t: 'duel_round', sc: d.sc, w: wt, n: d.n });
  }
  // w: equipo ganador (1v1 y 2v2) o id del ganador (FFA)
  async function duelEnd(r, w, ff) {
    const d = r.duel;
    d.live = false;
    clearTimeout(r.vetoT);
    let delta = null;
    const st = {}, ps = d.all.filter(x => x.user);
    const won = x => d.md === 'ffa' ? x.id === w : x.team === w;
    const users = await Promise.all(ps.map(x => store.getUser(x.user)));
    const ranked = d.md !== 'ffa' && ps.length === d.all.length && users.every(Boolean)
      && new Set(ps.map(x => x.user.toLowerCase())).size === ps.length;
    if (ranked) {
      // Elo por equipos: se compara el promedio de cada equipo y todos suman o restan lo mismo
      const avg = t => { const l = ps.map((x, i) => x.team === t ? users[i].stats.rating : null).filter(v => v != null); return l.reduce((a, b) => a + b, 0) / l.length; };
      const ew = 1 / (1 + 10 ** ((avg(1 - w) - avg(w)) / 400));
      delta = Math.max(1, Math.round(32 * (1 - ew)));
    }
    await Promise.all(ps.map((x, i) => {
      if (!users[i]) return;
      const s = { ...DEFAULT_STATS, ...users[i].stats };
      s.matches++; won(x) ? s.wins++ : s.losses++;
      s.kills += d.md === 'ffa' ? d.sc[x.id] || 0 : d.k[x.id] || 0;
      s.deaths += d.de[x.id] || 0;
      if (delta) s.rating = Math.max(100, s.rating + (won(x) ? delta : -delta));
      st[x.id] = s;
      return store.updateUser(users[i].name, { stats: s });
    }));
    duelBroadcast(r, { t: 'duel_end', w, sc: d.sc, ff: ff ? 1 : 0, d: delta, st, md: d.md });
  }
  function duelLeft(r, ws) {
    const d = r.duel;
    if (!d.live) return duelRoomInfo(r);
    if (d.veto && !d.veto.done && d.veto.turn === ws.id) setTimeout(() => vetoTurn(r), 300);   // le tocaba al que se fue
    if (d.md === 'ffa') {
      if (r.size < 2) { const last = [...r][0]; duelEnd(r, last ? last.id : 0, true); }
      return;
    }
    if (![...r].some(x => x.team === ws.team)) return duelEnd(r, 1 - ws.team, true);   // su equipo quedó vacío
    duelDeath(r, ws, 0);   // en 2v2 cuenta como caído en esta ronda
  }

  // ---------- búsqueda de partida
  const queues = { '1v1': [], '2v2': [], ffa: [] };
  const dropQ = ws => { for (const k in queues) queues[k] = queues[k].filter(x => x !== ws && x.readyState === 1 && !x.room); };
  function queueMatch(md, n) {
    const q = queues[md], take = q.splice(0, n), name = { '1v1': 'V|#', '2v2': 'W|#', ffa: 'F|#' }[md] + duelN++;
    take.forEach(x => joinRoom(x, name));
    if (md === 'ffa') duelStart(rooms[name]);
  }
  function queueDuel(ws, md) {
    if (ws.room || !queues[md]) return;
    dropQ(ws);
    ws.qT = Date.now();
    queues[md].push(ws);
    if (queues[md].length >= QNEED[md]) return queueMatch(md, QNEED[md]);
    queues[md].forEach(x => send(x, { t: 'duel_wait', n: queues[md].length, need: QNEED[md] }));
  }
  // FFA: si no se llena, arranca con 3 jugadores a los 8 s o con 2 a los 20 s
  setInterval(() => {
    dropQ(null);
    const q = queues.ffa, wait = q.length ? Date.now() - q[0].qT : 0;
    if (q.length >= 3 && wait > 8000 || q.length >= 2 && wait > 20000) queueMatch('ffa', Math.min(8, q.length));
  }, 1000);

  wss.on('connection', ws => {
    ws.id = nextId++;
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.n) ws.nick = String(m.n).slice(0, 12);
      if (m.t === 'auth') { ws.user = readToken(m.token); return send(ws, { t: 'authok', ok: !!ws.user }); }
      if (m.t === 'list') return send(ws, { t: 'rooms', l: list() });
      if ((m.t === 'join' || m.t === 'duel_q') && m.v !== GAME_V) return send(ws, { t: 'old', v: GAME_V });
      if (m.t === 'join') { if (!ws.room) joinRoom(ws, String(m.room || 'D|Sala 1').slice(0, 30), m.max); return; }
      if (m.t === 'duel_q') return queueDuel(ws, m.md in queues ? m.md : '1v1');
      if (m.t === 'duel_qx') return dropQ(ws);
      const r = rooms[ws.room];
      if (!r) return;
      if (r.duel && m.t === 'veto') return doVeto(r, ws.id, m.w | 0, false);
      if (r.duel && m.t === 'dd') { if (r.duel.veto && !r.duel.veto.done) return; return duelDeath(r, ws, m.k); }
      if (r.duel && m.t === 'duel_go') { if (ws.host && !r.duel.live && r.size >= 2) duelStart(r); return; }
      if (r.duel && m.t === 'duel_again') {
        if (r.duel.live) return;
        ws.again = true;
        const need = r.pv.md === 'ffa' ? 2 : r.max, ready = [...r].filter(x => x.again).length;
        if (r.size >= need && ready === r.size) duelStart(r);
        else duelBroadcast(r, { t: 'duel_again', id: ws.id, n: ready, need: Math.max(need, r.size) });
        return;
      }
      m.from = ws.id;
      r.forEach(o => { if (m.to ? o.id === m.to : o !== ws) send(o, m); });
    });
    ws.on('close', () => {
      dropQ(ws);
      const r = rooms[ws.room];
      if (!r) return;
      r.delete(ws);
      r.forEach(o => send(o, { t: 'left', id: ws.id }));
      if (ws.host && r.size) { const n = [...r][0]; n.host = true; send(n, { t: 'host' }); } // pasa el anfitrión
      if (r.duel && r.size) duelLeft(r, ws);   // abandono en PvP
      if (!r.size) delete rooms[ws.room];
    });
  });

  server.listen(PORT, () => {
    console.log('Servidor escuchando en el puerto', PORT, '· cuentas:', store.kind);
    if (store.kind !== 'PostgreSQL') console.warn('ATENCIÓN: sin DATABASE_URL las cuentas y el ranking se borran cada vez que Render reinicia el servidor.');
  });
})();
