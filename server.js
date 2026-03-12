const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ────────────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
  return Math.floor(100 + Math.random() * 900).toString();
}

const TASKS = [
  { id: 'wires',   label: 'Fix the Wires',       icon: '⚡', room: 'Engine Room'   },
  { id: 'fuel',    label: 'Refuel the Core',      icon: '🔋', room: 'Power Core'    },
  { id: 'nav',     label: 'Calibrate Navigation', icon: '🧭', room: 'Bridge'        },
  { id: 'shields', label: 'Repair Shields',       icon: '🛡️', room: 'Hull Deck'     },
  { id: 'scan',    label: 'Run Bio-Scan',         icon: '🔬', room: 'Med Bay'       },
  { id: 'comms',   label: 'Restore Comms',        icon: '📡', room: 'Comms Tower'   },
  { id: 'oxygen',  label: 'Fix O2 Generator',     icon: '💨', room: 'Life Support'  },
  { id: 'reactor', label: 'Stabilize Reactor',    icon: '☢️',  room: 'Reactor Core'  },
];

const PLAYER_COLORS = [
  '#FF4757','#FFA502','#2ED573','#1E90FF',
  '#A29BFE','#FD79A8','#00CEC9','#FDCB6E',
  '#E17055','#74B9FF','#55EFC4','#DFE6E9'
];

function createRoom(hostSocketId, hostName) {
  const code = generateCode();
  rooms[code] = {
    code,
    host: hostSocketId,
    phase: 'lobby',       // lobby | playing | discussion | voting | ended
    players: {},
    ghosts: [],
    votes: {},
    taskProgress: 0,
    totalTasks: 0,
    discussionTime: 30,
    votingTime: 20,
    discussionTimer: null,
    votingTimer: null,
    settings: { ghostCount: 1, discussionTime: 30, taskCount: 3 }
  };
  return code;
}

function assignRoles(room) {
  const playerIds = Object.keys(room.players);
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const numGhosts = Math.min(room.settings.ghostCount, Math.floor(playerIds.length / 3));

  room.ghosts = shuffled.slice(0, numGhosts);

  playerIds.forEach((id, idx) => {
    room.players[id].role = room.ghosts.includes(id) ? 'ghost' : 'crew';
    room.players[id].alive = true;
    room.players[id].color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
    room.players[id].tasks = [];
    room.players[id].completedTasks = 0;
    room.players[id].location = 'Bridge';

    if (room.players[id].role === 'crew') {
      const shuffledTasks = [...TASKS].sort(() => Math.random() - 0.5);
      room.players[id].tasks = shuffledTasks.slice(0, room.settings.taskCount).map(t => ({ ...t, done: false }));
      room.totalTasks += room.settings.taskCount;
    }
  });
}

function getRoomState(room, forPlayerId) {
  const player = room.players[forPlayerId];
  const isGhost = player?.role === 'ghost';

  const playersPublic = {};
  Object.entries(room.players).forEach(([id, p]) => {
    playersPublic[id] = {
      id, name: p.name, color: p.color,
      alive: p.alive, location: p.location,
      isHost: id === room.host,
      role: (isGhost || id === forPlayerId) ? p.role : (p.alive ? 'unknown' : p.role),
    };
  });

  return {
    code: room.code,
    phase: room.phase,
    players: playersPublic,
    taskProgress: room.taskProgress,
    totalTasks: room.totalTasks,
    votes: room.phase === 'voting' ? room.votes : {},
    myRole: player?.role,
    myTasks: player?.tasks || [],
    myLocation: player?.location,
    ghosts: isGhost ? room.ghosts : [],
    settings: room.settings,
  };
}

function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  Object.keys(room.players).forEach(pid => {
    const socket = io.sockets.sockets.get(pid);
    if (socket) socket.emit('gameState', getRoomState(room, pid));
  });
  // send host-only data
  const hostSocket = io.sockets.sockets.get(room.host);
  if (hostSocket) {
    hostSocket.emit('hostData', {
      ghosts: room.ghosts,
      allPlayers: room.players,
      phase: room.phase,
    });
  }
}

function checkWinConditions(room) {
  const aliveCrew = Object.values(room.players).filter(p => p.role === 'crew' && p.alive);
  const aliveGhosts = Object.values(room.players).filter(p => p.role === 'ghost' && p.alive);

  if (aliveGhosts.length === 0) return 'crew';
  if (aliveGhosts.length >= aliveCrew.length) return 'ghost';
  if (room.taskProgress >= room.totalTasks && room.totalTasks > 0) return 'crew';
  return null;
}

function startDiscussion(roomCode, reporterId, reportedName) {
  const room = rooms[roomCode];
  if (!room || room.phase === 'discussion' || room.phase === 'voting') return;

  room.phase = 'discussion';
  room.votes = {};
  const timeLeft = room.settings.discussionTime;

  io.to(roomCode).emit('discussionStart', {
    reporterName: room.players[reporterId]?.name || 'Unknown',
    reportedName: reportedName || null,
    timeLeft,
  });

  broadcastState(roomCode);

  let t = timeLeft;
  room.discussionTimer = setInterval(() => {
    t--;
    io.to(roomCode).emit('timerTick', { phase: 'discussion', timeLeft: t });
    if (t <= 0) {
      clearInterval(room.discussionTimer);
      startVoting(roomCode);
    }
  }, 1000);
}

function startVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.phase = 'voting';
  io.to(roomCode).emit('votingStart', { timeLeft: room.settings.votingTime || 20 });
  broadcastState(roomCode);

  let t = room.settings.votingTime || 20;
  room.votingTimer = setInterval(() => {
    t--;
    io.to(roomCode).emit('timerTick', { phase: 'voting', timeLeft: t });
    if (t <= 0) {
      clearInterval(room.votingTimer);
      resolveVotes(roomCode);
    }
  }, 1000);
}

function resolveVotes(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const tally = {};
  Object.values(room.votes).forEach(v => {
    tally[v] = (tally[v] || 0) + 1;
  });

  let maxVotes = 0, ejected = null, tie = false;
  Object.entries(tally).forEach(([pid, count]) => {
    if (pid === 'skip') return;
    if (count > maxVotes) { maxVotes = count; ejected = pid; tie = false; }
    else if (count === maxVotes) tie = true;
  });

  if (tie || !ejected || (tally['skip'] || 0) >= maxVotes) {
    io.to(roomCode).emit('voteResult', { ejected: null, skipped: true });
  } else {
    const p = room.players[ejected];
    if (p) {
      p.alive = false;
      io.to(roomCode).emit('voteResult', {
        ejected: ejected,
        ejectedName: p.name,
        ejectedRole: p.role,
        skipped: false,
        tally,
      });
    }
  }

  room.phase = 'playing';
  const winner = checkWinConditions(room);
  if (winner) {
    endGame(roomCode, winner);
    return;
  }

  setTimeout(() => {
    broadcastState(roomCode);
  }, 4000);
}

function endGame(roomCode, winner) {
  const room = rooms[roomCode];
  if (!room) return;
  room.phase = 'ended';

  const results = Object.values(room.players).map(p => ({
    name: p.name, role: p.role, color: p.color, alive: p.alive
  }));

  io.to(roomCode).emit('gameEnded', { winner, results });
  broadcastState(roomCode);
}

// ─── Socket Events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('createRoom', ({ hostName, settings }) => {
    const code = createRoom(socket.id, hostName);
    const room = rooms[code];
    room.players[socket.id] = { id: socket.id, name: hostName, role: null, alive: true, color: PLAYER_COLORS[0], tasks: [], completedTasks: 0, location: 'Bridge' };
    if (settings) Object.assign(room.settings, settings);
    socket.join(code);
    socket.emit('roomCreated', { code });
    broadcastState(code);
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { message: 'Room not found' });
    if (room.phase !== 'lobby') return socket.emit('error', { message: 'Game already started' });
    if (Object.keys(room.players).length >= 12) return socket.emit('error', { message: 'Room is full' });

    const colorIdx = Object.keys(room.players).length;
    room.players[socket.id] = { id: socket.id, name: playerName, role: null, alive: true, color: PLAYER_COLORS[colorIdx % PLAYER_COLORS.length], tasks: [], completedTasks: 0, location: 'Bridge' };
    socket.join(code);
    socket.emit('joinedRoom', { code });
    broadcastState(code);
    io.to(code).emit('playerJoined', { name: playerName });
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (Object.keys(room.players).length < 3) return socket.emit('error', { message: 'Need at least 3 players' });

    assignRoles(room);
    room.phase = 'playing';
    io.to(code).emit('gameStarted');
    broadcastState(code);
  });

  socket.on('moveToRoom', ({ code, roomName }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;
    player.location = roomName;
    broadcastState(code);
  });

  socket.on('doTask', ({ code, taskId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || player.role !== 'crew' || !player.alive) return;

    const task = player.tasks.find(t => t.id === taskId && !t.done);
    if (!task) return;

    setTimeout(() => {
      task.done = true;
      player.completedTasks++;
      room.taskProgress++;

      socket.emit('taskCompleted', { taskId, taskLabel: task.label });
      io.to(code).emit('taskProgressUpdate', { progress: room.taskProgress, total: room.totalTasks });

      const winner = checkWinConditions(room);
      if (winner) endGame(code, winner);
      else broadcastState(code);
    }, 2500);
  });

  socket.on('eliminatePlayer', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const ghost = room.players[socket.id];
    const target = room.players[targetId];
    if (!ghost || ghost.role !== 'ghost' || !ghost.alive) return;
    if (!target || !target.alive || target.role === 'ghost') return;

    const ghostLoc = ghost.location;
    const targetLoc = target.location;
    if (ghostLoc !== targetLoc) return socket.emit('error', { message: 'Target not in same room' });

    target.alive = false;
    socket.emit('eliminationSuccess', { targetName: target.name });
    io.to(code).emit('playerEliminated', { name: target.name, color: target.color, location: targetLoc });

    const winner = checkWinConditions(room);
    if (winner) endGame(code, winner);
    else broadcastState(code);
  });

  socket.on('reportBody', ({ code, bodyName }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    startDiscussion(code, socket.id, bodyName);
  });

  socket.on('callMeeting', ({ code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;
    startDiscussion(code, socket.id, null);
  });

  socket.on('sendMessage', ({ code, message }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    // During game, only alive players + ghosts can chat; during discussion anyone
    if (room.phase === 'playing' && player.role !== 'ghost') return;

    io.to(code).emit('chatMessage', {
      sender: player.name,
      color: player.color,
      message: message.substring(0, 200),
      isGhost: player.role === 'ghost',
    });
  });

  socket.on('castVote', ({ code, targetId }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'voting') return;
    const player = room.players[socket.id];
    if (!player || !player.alive) return;
    if (room.votes[socket.id]) return;

    room.votes[socket.id] = targetId;
    io.to(code).emit('votecast', { voterName: player.name, totalVotes: Object.keys(room.votes).length });

    const alivePlayers = Object.values(room.players).filter(p => p.alive).length;
    if (Object.keys(room.votes).length >= alivePlayers) {
      clearInterval(room.votingTimer);
      resolveVotes(code);
    }
  });

  socket.on('disconnect', () => {
    Object.entries(rooms).forEach(([code, room]) => {
      if (room.players[socket.id]) {
        const name = room.players[socket.id].name;
        delete room.players[socket.id];
        if (Object.keys(room.players).length === 0) {
          delete rooms[code];
        } else {
          if (room.host === socket.id) {
            room.host = Object.keys(room.players)[0];
            io.to(code).emit('newHost', { name: room.players[room.host].name });
          }
          io.to(code).emit('playerLeft', { name });
          broadcastState(code);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Ghost Hunt server running on port ${PORT}`));
