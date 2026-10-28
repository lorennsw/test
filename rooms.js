// Motor de salas del Pixel Shooter: cooperativo, búsqueda de partida y PvP (ruleta, veto, rondas, Elo).
// Lo usan el servidor online (server.js, en Node) y el celular que crea una partida local
// (Wi-Fi o Bluetooth, dentro del juego). Así las reglas son las mismas en los dos lados.
//
// createRooms({ store, readToken, gameV, lobby }) devuelve { open(ws), message(ws, texto), close(ws) }.
// Cada "ws" es cualquier objeto con send(texto) y readyState (1 = abierto).
// Sin store (partida local) no hay ranking: el PvP no cambia el Elo.
// lobby (solo partida local): al terminar se puede volver a la sala, cambiar de modo y empezar cuando todos están listos.
// Las salas "P|código" (salas online con amigos) funcionan igual: arrancan en la sala y el nombre no cambia.
(function (root) {
  const MAX = 4;                                        // jugadores por sala si el cliente no elige
  const MIN_P = 2, TOP_P = 8;                           // límites para la cantidad elegida
  const DEFAULT_ROOMS = [];                             // sin salas fijas: las crean los jugadores
  const WIN_ROUNDS = 3;                                 // duelo al mejor de 5
  const DUEL_MAPS = 6;                                  // mapas del duelo (el cliente los dibuja)
  const FFA_KILLS = 10;                                 // todos contra todos: gana el primero en llegar
  const WEAPONS = 8, VETO_S = 12, ROULETTE_MS = 5800;   // veto de armas: 12 s por turno, empieza al terminar la ruleta
  const DEFAULT_STATS = { rating: 1000, wins: 0, losses: 0, kills: 0, deaths: 0, matches: 0 };

  function createRooms({ store = null, readToken = () => null, gameV, lobby = false }) {
    const rooms = {};
    let nextId = 1, duelN = 1;
    const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    // salas públicas: las de siempre y las salas con amigos marcadas como públicas (con su modo y nombre)
    const list = () => [...new Set([...DEFAULT_ROOMS, ...Object.keys(rooms).filter(n => !n.includes('|#') && (!n.startsWith('P|') || rooms[n].pub))])]
      .map(n => { const r = rooms[n]; if (!r) return [n, 0, MAX]; const busy = r.duel && r.duel.live;
        return r.party ? [n, r.size, busy ? r.size : r.max, r.lob ? r.lob.md : r.md, r.title || ''] : [n, r.size, r.max]; });
    const nameOf = ws => ws.user || ws.nick || 'Jugador';
    const getUser = name => store ? store.getUser(name) : null;

    // Salas PvP según el prefijo del nombre: V| 1v1, W| 2v2, X| 3v3, Y| 4v4, F| todos contra todos
    const PV = { 'V|': { md: '1v1', max: 2 }, 'W|': { md: '2v2', max: 4 }, 'X|': { md: '3v3', max: 6 }, 'Y|': { md: '4v4', max: 8 }, 'F|': { md: 'ffa', max: 8 } };
    const QNEED = { '1v1': 2, '2v2': 4, '3v3': 6, '4v4': 8, ffa: 6 };
    const teamSize = md => ({ '2v2': 2, '3v3': 3, '4v4': 4 })[md] || 0;   // jugadores por equipo en los modos por equipos
    const pvOf = name => PV[name.slice(0, 2)];

    function joinRoom(ws, name, max, cfg) {
      const pv = pvOf(name);
      // el que crea la sala elige cuántos jugadores entran (las salas PvP tienen tamaño fijo)
      const party = name.startsWith('P|');
      const r = rooms[name] || Object.assign(new Set(), { max: party ? TOP_P : pv ? pv.max : Math.max(MIN_P, Math.min(TOP_P, max | 0 || MAX)) });
      if (party && !rooms[name]) {   // sala con amigos: empieza en la sala, con lo que eligió el que la creó
        const c = cfg && typeof cfg === 'object' ? cfg : {};
        r.party = true; r.lob = { md: MODES[c.md] ? c.md : 'dung', rd: new Set(), tm: new Map() };
        r.cmax = Math.max(1, Math.min(TOP_P, c.max | 0 || TOP_P)); setCfg(r, c); lobbyMax(r);
      }
      if (r.size >= r.max || (r.duel && r.duel.live)) return send(ws, { t: 'full' });
      if (pv && !r.duel) { r.pv = pv; r.duel = { live: false }; }
      rooms[name] = r;
      ws.room = name;
      ws.host = r.size === 0;                         // el primero es el anfitrión (maneja los enemigos)
      r.add(ws);
      send(ws, { t: 'welcome', id: ws.id, host: ws.host, max: r.max, lob: r.lob ? 1 : 0, md: r.md || undefined });
      if (r.lob) return lobbyInfo(r);
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
      // equipos de la sala local: los que eligieron los jugadores (si siguen estando todos)
      const fx = teamSize(md) && r.tm && ps.every(x => r.tm.has(x.id)) ? r.tm : null;
      // el servidor sortea el mapa (distinto al anterior en una revancha) para que todos vean el mismo
      let mp = Math.floor(Math.random() * DUEL_MAPS);
      if (mp === r.lastMp) mp = (mp + 1 + Math.floor(Math.random() * (DUEL_MAPS - 1))) % DUEL_MAPS;
      r.lastMp = mp;
      ps.forEach((x, i) => { x.team = md === 'ffa' ? i : fx ? fx.get(x.id) : (i < ps.length / 2 ? 0 : 1); x.again = false; x.deadN = 0; });
      r.duel = { live: true, md, n: 1, all: ps, k: {}, de: {}, sc: md === 'ffa' ? Object.fromEntries(ps.map(x => [x.id, 0])) : { 0: 0, 1: 0 } };
      const info = await Promise.all(ps.map(async x => {
        const u = x.user && await getUser(x.user);
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
    // w: equipo ganador (1v1 y por equipos) o id del ganador (FFA)
    async function duelEnd(r, w, ff) {
      const d = r.duel;
      d.live = false;
      clearTimeout(r.vetoT);
      let delta = null;
      const st = {}, ps = store ? d.all.filter(x => x.user) : [];   // sin store (partida local) no hay ranking
      const won = x => d.md === 'ffa' ? x.id === w : x.team === w;
      const users = await Promise.all(ps.map(x => getUser(x.user)));
      const ranked = d.md !== 'ffa' && ps.length > 0 && ps.length === d.all.length && users.every(Boolean)
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
      duelDeath(r, ws, 0);   // por equipos cuenta como caído en esta ronda
    }

    // ---------- sala local: al terminar todos vuelven, el anfitrión elige el modo y se empieza cuando están todos listos
    const MODES = { dung: 'D|', camp: 'C|', surv: 'S|', '1v1': 'V|', '2v2': 'W|', '3v3': 'X|', '4v4': 'Y|', ffa: 'F|' };
    const lobbyNeed = md => md === 'ffa' ? [2, TOP_P] : md === '1v1' ? [2, 2] : teamSize(md) ? [teamSize(md) * 2, teamSize(md) * 2] : [1, TOP_P];
    // configuración de la sala con amigos: pública o no, nombre y contra quién se juega el PvP
    // (in: entre ellos · pub: contra otras personas, la sala aparece en la lista · bots: contra bots, sin ranking)
    function setCfg(r, c) {
      if ('title' in c) r.title = String(c.title || '').slice(0, 17);
      if ('rival' in c) r.rival = ['in', 'pub', 'bots'].includes(c.rival) ? c.rival : 'in';
      if ('pub' in c) r.pub = !!c.pub;
      if (r.rival === 'pub') r.pub = true;
      if ('max' in c && c.max) r.cmax = Math.max(1, Math.min(TOP_P, c.max | 0));
      if ('dif' in c) r.dif = Math.max(0, Math.min(2, c.dif | 0));   // dificultad de la mazmorra (para mostrarla)
    }
    // en la sala entran: en PvP los que pide el modo; en cooperativo los que eligió el anfitrión
    const lobbyMax = r => { const pv = PV[MODES[r.lob.md]]; r.max = Math.max(r.size, pv ? pv.max : r.cmax || TOP_P); };
    const lobbyInfo = r => duelBroadcast(r, { t: 'lob', md: r.lob.md, need: lobbyNeed(r.lob.md),
      cfg: r.party ? { title: r.title || '', rival: r.rival || 'in', pub: !!r.pub, max: r.cmax || TOP_P, dif: r.dif | 0 } : undefined,
      p: [...r].map(x => [x.id, nameOf(x), r.lob.rd.has(x.id) ? 1 : 0, x.host ? 1 : 0, r.lob.tm.has(x.id) ? r.lob.tm.get(x.id) : -1]) });
    // por equipos: cada uno elige el suyo (mitad y mitad) y se puede cambiar mientras haya lugar
    const teamOk = r => [0, 1].every(t => [...r].filter(x => r.lob.tm.get(x.id) === t).length === teamSize(r.lob.md));
    function lobbyOpen(r, md) {
      if (r.lob) return;
      if (r.duel) { r.duel.live = false; clearTimeout(r.vetoT); }
      r.lob = { md: MODES[md] ? md : 'dung', rd: new Set(), tm: new Map(r.tm || []) };   // los equipos de la última partida por equipos se mantienen
      if (r.party) lobbyMax(r); else r.max = TOP_P;
      lobbyInfo(r);
    }
    // si están todos listos y la cantidad sirve para el modo, arranca; la sala cambia de nombre según el modo
    function lobbyCheck(r) {
      const l = r.lob, [a, b] = lobbyNeed(l.md);
      if (r.size < a || r.size > b || [...r].some(x => !l.rd.has(x.id)) || (teamSize(l.md) && !teamOk(r))) return lobbyInfo(r);
      const old = [...r][0].room, name = r.party ? old : MODES[l.md] + old.slice(2), pv = PV[MODES[l.md]];
      if (name !== old) { delete rooms[old]; rooms[name] = r; r.forEach(x => { x.room = name; }); }
      r.md = l.md;
      r.lob = null; r.tm = teamSize(l.md) ? l.tm : null; r.pv = pv || null; r.duel = pv ? { live: false } : null; r.max = pv ? pv.max : (r.party && r.cmax) || TOP_P;
      duelBroadcast(r, { t: 'lob_go', md: l.md, room: name, max: r.max });
      if (pv) duelStart(r);
    }

    // ---------- búsqueda de partida
    const queues = { '1v1': [], '2v2': [], '3v3': [], '4v4': [], ffa: [] };
    const dropQ = ws => { for (const k in queues) queues[k] = queues[k].filter(x => x !== ws && x.readyState === 1 && !x.room); };
    function queueMatch(md, n) {
      const q = queues[md], take = q.splice(0, n), name = { '1v1': 'V|#', '2v2': 'W|#', '3v3': 'X|#', '4v4': 'Y|#', ffa: 'F|#' }[md] + duelN++;
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
      if (!queues.ffa.length) return;
      dropQ(null);
      const q = queues.ffa, wait = q.length ? Date.now() - q[0].qT : 0;
      if (q.length >= 3 && wait > 8000 || q.length >= 2 && wait > 20000) queueMatch('ffa', Math.min(8, q.length));
    }, 1000);

    const hub = {
      rooms, list,
      open(ws) { ws.id = nextId++; },
      message(ws, raw) {
        let m;
        try { m = JSON.parse(raw); } catch (e) { return; }
        if (!m || typeof m !== 'object') return;
        if (m.n) ws.nick = String(m.n).slice(0, 12);
        if (m.t === 'auth') { ws.user = readToken(m.token); return send(ws, { t: 'authok', ok: !!ws.user }); }
        if (m.t === 'list') return send(ws, { t: 'rooms', l: list() });
        if ((m.t === 'join' || m.t === 'duel_q') && m.v !== gameV) return send(ws, { t: 'old', v: gameV });
        if (m.t === 'join') { if (!ws.room) joinRoom(ws, String(m.room || 'D|Sala 1').slice(0, 30), m.max, m.cfg); return; }
        if (m.t === 'duel_q') return queueDuel(ws, m.md in queues ? m.md : '1v1');
        if (m.t === 'duel_qx') return dropQ(ws);
        if (m.t === 'leave') return leave(ws);
        const r = rooms[ws.room];
        if (!r) return;
        if ((lobby || r.party) && m.t === 'lobby') return lobbyOpen(r, m.md);
        if (r.lob && m.t === 'lob_md') { if (ws.host && MODES[m.md]) { r.lob.md = m.md; r.lob.rd.clear(); if (r.party) lobbyMax(r); lobbyInfo(r); } return; }
        if (r.lob && r.party && m.t === 'lob_cfg') { if (ws.host && m.cfg && typeof m.cfg === 'object') { setCfg(r, m.cfg); lobbyMax(r); lobbyInfo(r); } return; }
        if (r.lob && m.t === 'lob_tm') {
          const t = m.tm ? 1 : 0;
          if (r.lob.tm.get(ws.id) === t) { if (!m.x) return; r.lob.tm.delete(ws.id); }   // salir del equipo (para intercambiar) solo si se pide: así un mensaje repetido no te saca
          else if ([...r].filter(x => r.lob.tm.get(x.id) === t).length < (teamSize(r.lob.md) || 2)) r.lob.tm.set(ws.id, t);
          else return;
          r.lob.rd.delete(ws.id);
          return lobbyInfo(r);
        }
        if (r.lob && m.t === 'lob_rd') { m.on ? r.lob.rd.add(ws.id) : r.lob.rd.delete(ws.id); return lobbyCheck(r); }
        if (r.lob) return;                               // en la sala no se juega
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
      },
      close(ws) { leave(ws); }
    };
    // sale de la sala: al cerrar la conexión o, más rápido, cuando avisa con "leave" antes de cerrarla
    // (cerrar una conexión puede tardar bastante en el servidor gratis)
    function leave(ws) {
        dropQ(ws);
        const r = rooms[ws.room];
        if (!r) return;
        r.delete(ws);
        r.forEach(o => send(o, { t: 'left', id: ws.id }));
        if (ws.host && r.size) { const n = [...r][0]; n.host = true; send(n, { t: 'host' }); } // pasa el anfitrión
        if (r.lob && r.size) { r.lob.rd.delete(ws.id); r.lob.tm.delete(ws.id); lobbyCheck(r); }
        else if (r.duel && r.size) duelLeft(r, ws);   // abandono en PvP
        if (!r.size) delete rooms[ws.room];
        ws.room = null;
    }
    return hub;
  }

  const api = { createRooms, DEFAULT_STATS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PSRooms = api;
})(typeof window !== 'undefined' ? window : globalThis);
