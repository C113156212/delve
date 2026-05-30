const { CONFIG } = require('../shared/config');

const rooms = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < CONFIG.ROOM_CODE_LENGTH; i++)
    code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateCode() : code;
}

function createRoom(hostId, hostName) {
  const code = generateCode();
  rooms.set(code, {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, role: null }],
    phase: 'lobby',
  });
  return code;
}

function joinRoom(code, playerId, playerName) {
  const room = rooms.get(code.toUpperCase());
  if (!room)                                    return { error: '找不到房間' };
  if (room.phase !== 'lobby')                   return { error: '遊戲已經開始' };
  if (room.players.length >= CONFIG.MAX_PLAYERS) return { error: '房間已滿（最多 4 人）' };
  if (room.players.find(p => p.id === playerId)) return { error: '你已在房間內' };
  room.players.push({ id: playerId, name: playerName, role: null });
  return { ok: true, room };
}

function pickRole(code, playerId, role) {
  const VALID = ['scout', 'fighter', 'scholar', 'architect'];
  const room = rooms.get(code);
  if (!room)                    return { error: '找不到房間' };
  if (!VALID.includes(role))    return { error: '無效職業' };
  const takenBy = room.players.find(p => p.role === role && p.id !== playerId);
  if (takenBy)                  return { error: '職業已被選走' };
  const player = room.players.find(p => p.id === playerId);
  if (!player)                  return { error: '你不在這個房間' };
  player.role = role;
  return { ok: true, room };
}

function canStart(code) {
  const room = rooms.get(code);
  if (!room) return false;
  if (room.players.length < CONFIG.MIN_PLAYERS_TO_START) return false;
  return room.players.every(p => p.role !== null);
}

function getRoom(code)              { return rooms.get(code) || null; }
function setPhase(code, phase)      { const r = rooms.get(code); if (r) r.phase = phase; }
function removePlayer(code, pid)    {
  const room = rooms.get(code);
  if (!room) return;
  room.players = room.players.filter(p => p.id !== pid);
  if (room.players.length === 0) {
    rooms.delete(code);
  } else if (room.hostId === pid) {
    room.hostId = room.players[0].id;
  }
}

module.exports = { createRoom, joinRoom, pickRole, canStart, getRoom, setPhase, removePlayer };
