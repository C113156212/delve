'use strict';
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const { createRoom, joinRoom, pickRole, canStart, getRoom, setPhase, removePlayer } = require('./rooms');
const {
  createGameState, nextLevel, MAX_LEVEL, BEAT_MS, BEATS_PER_TURN,
  startTurn, resolveTurn, spawnWave,
  submitPlayerAction, movePlayerFree, placeWall, markMonster, scoutPing, quickMsg,
  checkEndConditions, filterStateForRole,
} = require('./game');

const app    = express();
const server = http.createServer(app);
const ORIGIN = process.env.CORS_ORIGIN || '*';
const io     = new Server(server, { cors: { origin: ORIGIN } });

app.use(express.static(path.join(__dirname, '../client')));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// ── Online count ──────────────────────────────────────────────────────────────
let onlineCount = 0;
let _onlineBcastTimer = null;
function _broadcastOnline() {
  clearTimeout(_onlineBcastTimer);
  _onlineBcastTimer = setTimeout(() => io.emit('online_count', { count: onlineCount }), 400);
}

// ── Quick match queue ─────────────────────────────────────────────────────────
// Vote-based: start immediately when everyone agrees, or when the queue is full.
// No countdown timer — players see how many people are waiting and can vote to start.
const matchQueue = []; // [{socketId, name, joinedAt, voted}]
const MATCH_MAX_SIZE = 4;

function _notifyQueue() {
  const votes = matchQueue.filter(p => p.voted).length;
  matchQueue.forEach((p, i) => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.emit('match_queue', {
      waiting: matchQueue.length,
      position: i + 1,
      votes,
      myVoted: p.voted,
      needMore: Math.max(0, 2 - matchQueue.length), // how many more to enable voting
    });
  });
}

function tryMatch(forceStart = false) {
  if (matchQueue.length === 0) return;
  const votes = matchQueue.filter(p => p.voted).length;
  const allVoted = matchQueue.length >= 2 && votes >= matchQueue.length;
  const isFull   = matchQueue.length >= MATCH_MAX_SIZE;
  if (!forceStart && !allVoted && !isFull) return;

  const party = matchQueue.splice(0, Math.min(MATCH_MAX_SIZE, matchQueue.length));
  _notifyQueue();

  const host = party[0];
  const code = createRoom(host.socketId, host.name);

  for (let i = 0; i < party.length; i++) {
    const p = party[i];
    const s = io.sockets.sockets.get(p.socketId);
    if (!s) continue;
    if (i > 0) joinRoom(code, p.socketId, p.name);
    s.join(code);
    s.data.code = code;
    s.data.name = p.name;
    s.emit('match_found', { code, room: getRoom(code), isHost: i === 0 });
  }
}

// ── Per-room game state & timer handles ──────────────────────────────────────
const gameStates = new Map();   // code -> gameState
const roomTimers = new Map();   // code -> { broadcast, beat }

async function broadcastGameState(code) {
  const gs = gameStates.get(code);
  if (!gs) return;
  // Skip broadcast when state hasn't changed since last send
  if (gs.lastBroadcastAt && gs.lastBroadcastAt >= gs.lastChangeAt) return;
  gs.lastBroadcastAt = Date.now();
  const sockets = await io.in(code).fetchSockets();
  for (const s of sockets) {
    const role = s.data.role;
    if (!role) continue;
    s.emit('game_state', filterStateForRole(gs, role, s.id));
  }
}

function handleResult(code, result, gs) {
  if (!result) return;
  if (result === 'next_level') {
    const completedLevel = gs.level;
    gs.phase = 'transitioning';
    io.to(code).emit('level_up', { completedLevel, nextLevel: completedLevel + 1, maxLevel: MAX_LEVEL, levelType: gs.levelType });
    setTimeout(() => {
      const gs2 = gameStates.get(code);
      if (!gs2) return;
      if (!getRoom(code)) { gameStates.delete(code); clearAllTimers(code); return; }
      nextLevel(gs2);
      gs2.lastChangeAt = Date.now();
      startTurn(gs2);
      broadcastGameState(code);
    }, 3000);
  } else {
    io.to(code).emit('game_end', { result, players: gs.players });
    clearAllTimers(code);
    gameStates.delete(code);
  }
}

function startGameTicks(code) {
  const BROADCAST_MS = 100;

  const broadcast = setInterval(async () => {
    const gs = gameStates.get(code);
    if (!gs || gs.phase === 'ended') { clearAllTimers(code); return; }
    await broadcastGameState(code);
  }, BROADCAST_MS);

  let beatCount = 0;
  let lastBeatTime = Date.now();
  const beat = setInterval(() => {
    const gs = gameStates.get(code);
    if (!gs || gs.phase === 'ended' || gs.phase === 'transitioning') return;

    const now = Date.now();
    const beatMs = gs.beatMs || BEAT_MS;
    if (now - lastBeatTime < beatMs) return;
    lastBeatTime = now;

    beatCount++;
    gs.beat = ((beatCount - 1) % BEATS_PER_TURN) + 1;

    resolveTurn(gs);
    const result = checkEndConditions(gs);
    if (result) { handleResult(code, result, gs); return; }
    startTurn(gs);
    gs.lastChangeAt = now; // beat always changes state

    io.to(code).emit('beat', { beat: gs.beat, turn: gs.turn, beatMs: gs.beatMs });
  }, 80);

  roomTimers.set(code, { broadcast, beat });
}

function clearAllTimers(code) {
  const t = roomTimers.get(code);
  if (t) { clearInterval(t.broadcast); clearInterval(t.beat); }
  roomTimers.delete(code);
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineCount++;
  socket.emit('online_count', { count: onlineCount }); // immediate for new client
  _broadcastOnline();

  socket.on('create_room', ({ name }) => {
    const code = createRoom(socket.id, name);
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('room_created', { code, room: getRoom(code) });
  });

  socket.on('join_room', ({ name, code }) => {
    const result = joinRoom(code, socket.id, name);
    if (result.error) { socket.emit('error_msg', { msg: result.error }); return; }
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('room_joined', { code, room: result.room });
    socket.to(code).emit('room_updated', { room: result.room });
  });

  socket.on('pick_role', ({ role }) => {
    const code = socket.data.code;
    if (!code) return;
    const result = pickRole(code, socket.id, role);
    if (result.error) { socket.emit('error_msg', { msg: result.error }); return; }
    socket.data.role = role;
    socket.emit('role_confirmed', { role, room: result.room });
    socket.to(code).emit('room_updated', { room: result.room });
  });

  socket.on('start_game', () => {
    const code = socket.data.code;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('error_msg', { msg: '只有房主可以開始' }); return; }
    if (!canStart(code))           { socket.emit('error_msg', { msg: '還有人沒選職業' });   return; }

    // Auto-assign uncovered roles to the host as bonusRoles.
    // Host will receive the combined view and can act for those roles.
    const ALL_ROLES = ['fighter', 'scout', 'scholar', 'architect'];
    const covered = room.players.map(p => p.role);
    const uncovered = ALL_ROLES.filter(r => !covered.includes(r));
    if (uncovered.length > 0) {
      const host = room.players.find(p => p.id === room.hostId);
      if (host) host.bonusRoles = uncovered;
    }

    setPhase(code, 'playing');
    const gs = createGameState(room.players);
    gs.lastChangeAt = Date.now(); gs.lastBroadcastAt = 0;
    gs.playerCount = room.players.length;
    gameStates.set(code, gs);
    startGameTicks(code);
    io.to(code).emit('game_start', { room });
  });

  // ── Quick match ───────────────────────────────────────────────────────────

  socket.on('quick_match', ({ name }) => {
    if (matchQueue.find(p => p.socketId === socket.id)) return;
    if (socket.data.code) return;
    socket.data.name = name;
    matchQueue.push({ socketId: socket.id, name, joinedAt: Date.now(), voted: false });
    _notifyQueue();
    tryMatch();
  });

  socket.on('quick_match_vote', () => {
    const p = matchQueue.find(q => q.socketId === socket.id);
    if (!p) return;
    p.voted = true;
    _notifyQueue();
    tryMatch();
  });

  socket.on('cancel_match', () => {
    const idx = matchQueue.findIndex(p => p.socketId === socket.id);
    if (idx !== -1) { matchQueue.splice(idx, 1); _notifyQueue(); }
    socket.emit('match_cancelled');
  });

  // ── Turn submission ───────────────────────────────────────────────────────

  socket.on('player_submit', ({ dx, dy, combatAction, targetId }) => {
    const code = socket.data.code;
    const gs   = gameStates.get(code);
    if (!gs || gs.phase !== 'playing') return;
    if (!combatAction && !targetId) {
      const moved = movePlayerFree(gs, socket.id, dx || 0, dy || 0);
      if (moved === true) gs.lastChangeAt = Date.now();
      if (moved !== 'combat') return;
    }
    submitPlayerAction(gs, socket.id, dx, dy, combatAction, targetId ?? null);
    gs.lastChangeAt = Date.now();
  });

  // ── Architect wall ────────────────────────────────────────────────────────

  socket.on('place_wall', ({ x, y }) => {
    const code = socket.data.code;
    const gs   = gameStates.get(code);
    if (!gs || gs.phase !== 'playing') return;
    placeWall(gs, socket.id, x, y);
    gs.lastChangeAt = Date.now();
  });

  // ── Scholar mark ──────────────────────────────────────────────────────────

  socket.on('mark_monster', ({ monsterId }) => {
    const code = socket.data.code;
    const gs   = gameStates.get(code);
    if (!gs || gs.phase !== 'playing') return;
    markMonster(gs, socket.id, monsterId);
    gs.lastChangeAt = Date.now();
  });

  // ── Scout ping ────────────────────────────────────────────────────────────

  socket.on('scout_ping', ({ x, y }) => {
    const code = socket.data.code;
    const gs   = gameStates.get(code);
    if (!gs || gs.phase !== 'playing') return;
    scoutPing(gs, socket.id, x, y);
    gs.lastChangeAt = Date.now();
  });

  // ── Quick messages ────────────────────────────────────────────────────────

  socket.on('quick_msg', ({ text }) => {
    const code = socket.data.code;
    const gs   = gameStates.get(code);
    if (!gs) return;
    const allowed = [
      '敵人快到了！','快去出口！','我快死了！','幫我！',
      '出口在右下！','前方有陷阱！','我去吸引怪！','準備好了',
      '用架！','用刺！','用斬！','閃開！',
    ];
    if (allowed.includes(text)) { quickMsg(gs, socket.id, text); gs.lastChangeAt = Date.now(); }
  });

  // ── Debug cheats ──────────────────────────────────────────────────────────

  socket.on('debug_cheat', ({ cmd, val }) => {
    const code = socket.data.code;
    const gs   = gameStates.get(code);
    if (!gs || gs.phase !== 'playing') return;
    if (cmd === 'next_level') {
      for (const p of Object.values(gs.players)) if (p.hp > 0) p.atExit = true;
      handleResult(code, checkEndConditions(gs), gs);
    } else if (cmd === 'kill_monsters') {
      for (const m of gs.monsters) m.hp = 0;
      gs.lastChangeAt = Date.now();
    } else if (cmd === 'full_hp') {
      for (const p of Object.values(gs.players)) p.hp = p.maxHp;
      gs.lastChangeAt = Date.now();
    } else if (cmd === 'goto_level') {
      const target = Math.max(1, Math.min(Number(val) || 1, MAX_LEVEL));
      gs.level = target - 1;
      for (const p of Object.values(gs.players)) if (p.hp > 0) p.atExit = true;
      handleResult(code, checkEndConditions(gs), gs);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    onlineCount--;
    _broadcastOnline();

    // Remove from match queue
    const qi = matchQueue.findIndex(p => p.socketId === socket.id);
    if (qi !== -1) { matchQueue.splice(qi, 1); _notifyQueue(); }

    const code = socket.data.code;
    if (!code) return;
    const gs = gameStates.get(code);
    if (gs && gs.phase === 'playing') {
      const p = gs.players[socket.id];
      if (p) p.hp = 0;
      const result = checkEndConditions(gs);
      if (result) {
        io.to(code).emit('game_end', { result, players: gs.players });
        clearAllTimers(code);
        gameStates.delete(code);
      }
    }
    removePlayer(code, socket.id);
    const room = getRoom(code);
    if (room) io.to(code).emit('room_updated', { room });
    else clearAllTimers(code);
  });

});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DELVE running on http://localhost:${PORT}`));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') server.listen(Number(PORT) + 1);
  else throw e;
});
