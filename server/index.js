const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const { createRoom, joinRoom, pickRole, canStart, getRoom, setPhase, removePlayer } = require('./rooms');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// 靜態檔案
app.use(express.static(path.join(__dirname, '../client')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, '../client/index.html')));

// ── Socket 事件 ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // 建立房間
  socket.on('create_room', ({ name }) => {
    const code = createRoom(socket.id, name);
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('room_created', { code, room: getRoom(code) });
  });

  // 加入房間
  socket.on('join_room', ({ name, code }) => {
    const result = joinRoom(code, socket.id, name);
    if (result.error) { socket.emit('error_msg', { msg: result.error }); return; }
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    socket.emit('room_joined', { code, room: result.room });
    socket.to(code).emit('room_updated', { room: result.room });
  });

  // 選職業
  socket.on('pick_role', ({ role }) => {
    const code = socket.data.code;
    if (!code) return;
    const result = pickRole(code, socket.id, role);
    if (result.error) { socket.emit('error_msg', { msg: result.error }); return; }
    socket.data.role = role;
    // 告訴自己選好了，告訴所有人更新
    socket.emit('role_confirmed', { role, room: result.room });
    socket.to(code).emit('room_updated', { room: result.room });
  });

  // 開始遊戲（只有房主能觸發）
  socket.on('start_game', () => {
    const code = socket.data.code;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('error_msg', { msg: '只有房主可以開始' }); return; }
    if (!canStart(code)) { socket.emit('error_msg', { msg: '還有人沒選職業' }); return; }
    setPhase(code, 'playing');
    io.to(code).emit('game_start', { room });
  });

  // 斷線處理
  socket.on('disconnect', () => {
    const code = socket.data.code;
    if (!code) return;
    removePlayer(code, socket.id);
    const room = getRoom(code);
    if (room) io.to(code).emit('room_updated', { room });
  });

});

// ── 啟動 ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DELVE running on http://localhost:${PORT}`));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const next = Number(PORT) + 1;
    server.listen(next, () => console.log(`DELVE running on http://localhost:${next}`));
  } else throw e;
});
