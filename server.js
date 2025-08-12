const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('web'));
app.use(express.json());

// ----- word lists by topic -----
const WORD_LISTS = {
  classic: ['apple','jupiter','guitar','ocean','pyramid','subway','volcano','pancake','tornado','compass','castle'],
  disney:  ['Cinderella','Epcot','Imagineer','Monorail','Dole Whip','Haunted Mansion','Tinker Bell','Fantasia','Skyliner'],
  tech:    ['firewall','container','webhook','endpoint','kernel','router','timestamp','payload','virtualization'],
  food:    ['lasagna','sushi','taco','croissant','ramen','gelato','barbecue','dumpling','paella']
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ----- rooms -----
/**
 * rooms: Map<code, {
 *   code, host,
 *   players: Map<socketId,{name,isImposter?,word?,voteFor?}>,
 *   topic, phase: 'lobby'|'roles'|'discuss'|'vote'|'reveal',
 *   secretWord?,
 *   timerSec: number, voteTimerSec: number,
 *   roundNumber: number,            // increments each round
 *   order: string[],                // playerId order snapshot for this round
 *   startIndex: number,             // who starts this round (rotates)
 *   currentTurn: string|null,       // socketId whose turn it is
 *   turnsRemaining: number          // countdown to 0, then auto-vote
 * }>
 */
const rooms = new Map();
/** timers: Map<code,{ interval: NodeJS.Timeout, endsAt: number, kind: 'discuss'|'vote' }> */
const timers = new Map();

const ensureRoom = (code) => {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code, host: null, players: new Map(),
      topic: null, phase: 'lobby',
      secretWord: null,
      timerSec: 90,
      voteTimerSec: 25,
      roundNumber: 0,
      order: [],
      startIndex: 0,
      currentTurn: null,
      turnsRemaining: 0
    });
  }
  return rooms.get(code);
};
const publicState = (room) => ({
  code: room.code,
  host: room.host,
  topic: room.topic,
  phase: room.phase,
  timerSec: room.timerSec,
  voteTimerSec: room.voteTimerSec,
  currentTurn: room.currentTurn,
  order: room.order.map(id => ({ id, name: room.players.get(id)?.name || 'Player' })),
  players: Array.from(room.players.entries()).map(([id,p])=>({id,name:p.name}))
});
const emitUpdate = (code) => { const r = rooms.get(code); if (r) io.to(code).emit('room:update', publicState(r)); };
const stopTimer = (code) => { const t = timers.get(code); if (t?.interval) clearInterval(t.interval); timers.delete(code); };

// ----- vote helpers -----
function enterVote(code){
  const room = rooms.get(code);
  if (!room) return;
  stopTimer(code);
  room.phase = 'vote';
  for (const [,p] of room.players) p.voteFor = null;
  room.currentTurn = null;
  room.turnsRemaining = 0;
  emitUpdate(code);

  const endsAt = Date.now() + (room.voteTimerSec||25)*1000;
  const interval = setInterval(()=>{
    const ms = Math.max(0, endsAt - Date.now());
    const secs = Math.ceil(ms/1000);
    io.to(code).emit('timer:tick', { secs });
    if (ms <= 0) {
      stopTimer(code);
      doReveal(code);
    }
  }, 250);
  timers.set(code, { interval, endsAt, kind: 'vote' });
}

function doReveal(code){
  const room = rooms.get(code);
  if (!room) return;
  stopTimer(code);

  const votes = {};
  for (const [pid, p] of room.players) if (p.voteFor) votes[p.voteFor] = (votes[p.voteFor] || 0) + 1;
  let executed = null, max = -1;
  for (const [pid, count] of Object.entries(votes)) { if (count > max) { max = count; executed = pid; } }
  const executedPlayer = executed ? room.players.get(executed) : null;
  const imposters = Array.from(room.players.entries()).filter(([id,p])=>p.isImposter).map(([id])=>id);
  const isHit = executed ? !!executedPlayer?.isImposter : false;

  room.phase = 'reveal';
  io.to(code).emit('round:results', { executed: executed || null, isHit, imposters, secret: room.secretWord });
  emitUpdate(code);
}

// ----- sockets -----
io.on('connection', (socket) => {
  let currentRoom = null;
  socket.on('room:create', ({ code, name }) => {
    const room = ensureRoom(code);
    room.host = socket.id;
    room.players.set(socket.id, { name: name || 'Host' });
    socket.join(code);
    currentRoom = code;
    emitUpdate(code);
  });

  socket.on('room:join', ({ code, name }) => {
    const room = ensureRoom(code);
    room.players.set(socket.id, { name: name || 'Player' });
    socket.join(code);
    currentRoom = code;
    emitUpdate(code);
  });

  socket.on('topic:set', ({ code, topic }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    const key = String(topic || '').toLowerCase();
    room.topic = ['classic','disney','tech','food'].includes(key) ? key : 'classic';
    room.phase = 'lobby';
    room.secretWord = null;
    room.currentTurn = null; room.turnsRemaining = 0;
    for (const [,p] of room.players) { delete p.isImposter; delete p.word; delete p.voteFor; }
    emitUpdate(code);
  });

  socket.on('timer:set', ({ code, seconds }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    const s = Math.floor(Number(seconds));
    if (s >= 10 && s <= 600) { room.timerSec = s; emitUpdate(code); }
  });

  socket.on('voteTimer:set', ({ code, seconds }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    const s = Math.floor(Number(seconds));
    if (s >= 5 && s <= 180) { room.voteTimerSec = s; emitUpdate(code); }
  });

  // Deal roles (3+ players) and prep turn order with rotating starter
  socket.on('round:deal', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;

    const ids = Array.from(room.players.keys());
    const minPlayers = 3;
    if (ids.length < minPlayers) {
      io.to(socket.id).emit('round:error', { reason: 'not_enough_players', need: minPlayers, have: ids.length });
      return;
    }

    const topic = room.topic || 'classic';
    const list = WORD_LISTS[topic] || WORD_LISTS.classic;
    const secret = pick(list);
    room.secretWord = secret;

    const imposterId = ids[Math.floor(Math.random()*ids.length)];
    for (const [id,p] of room.players) {
      const isImp = id === imposterId;
      p.isImposter = isImp;
      p.word = isImp ? null : secret;
      p.voteFor = null;
      io.to(id).emit('role:assign', { topic, isImposter: isImp, word: isImp ? null : secret });
    }

    // Turn order snapshot + rotate start each round
    room.order = Array.from(room.players.keys());
    room.roundNumber = (room.roundNumber || 0) + 1;
    room.startIndex = (room.roundNumber - 1) % room.order.length;
    room.currentTurn = null;
    room.turnsRemaining = 0;

    room.phase = 'roles';
    stopTimer(code);
    emitUpdate(code);
  });

  // Start discussion + timer + first turn (rotating starter)
  socket.on('round:discuss', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;

    room.phase = 'discuss';
    // Init turn cycle
    if (!room.order || room.order.length === 0) room.order = Array.from(room.players.keys());
    room.turnsRemaining = room.order.length;
    room.currentTurn = room.order[room.startIndex];
    io.to(code).emit('turn:state', { currentTurn: room.currentTurn, order: room.order });

    emitUpdate(code);

    // discussion timer
    stopTimer(code);
    const endsAt = Date.now() + (room.timerSec || 90) * 1000;
    const interval = setInterval(()=>{
      const ms = Math.max(0, endsAt - Date.now());
      const secs = Math.ceil(ms/1000);
      io.to(code).emit('timer:tick', { secs });
      if (ms <= 0) {
        stopTimer(code);
        enterVote(code); // auto move to vote
        io.to(code).emit('timer:end');
      }
    }, 250);
    timers.set(code, { interval, endsAt, kind: 'discuss' });
  });

  // Host can jump to vote manually
  socket.on('round:start-vote', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    enterVote(code);
  });

  // Player submits their description word (only on their turn)
  socket.on('turn:submit', ({ code, word }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'discuss') return;
    const clean = String(word || '').trim().slice(0, 40);
    if (!clean) return;
    if (socket.id !== room.currentTurn) return; // not your turn

    const player = room.players.get(socket.id);
    io.to(code).emit('turn:word', {
      pid: socket.id,
      name: player?.name || 'Player',
      text: clean
    });

    // advance turn
    room.turnsRemaining = Math.max(0, (room.turnsRemaining || 1) - 1);
    if (room.turnsRemaining <= 0) {
      // all went — enter vote immediately
      enterVote(code);
    } else {
      const idx = room.order.findIndex(id => id === room.currentTurn);
      const nextIdx = (idx + 1) % room.order.length;
      room.currentTurn = room.order[nextIdx];
      io.to(code).emit('turn:state', { currentTurn: room.currentTurn, order: room.order });
      emitUpdate(code);
    }
  });

  // Voting
  socket.on('vote:cast', ({ code, targetId }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'vote') return;
    if (!room.players.has(targetId) || targetId === socket.id) return;
    const voter = room.players.get(socket.id);
    if (!voter) return;
    voter.voteFor = targetId;

    const tally = {};
    let voted = 0;
    for (const [,p] of room.players) if (p.voteFor) { tally[p.voteFor] = (tally[p.voteFor] || 0) + 1; voted++; }
    io.to(code).emit('vote:update', { tally });

    if (voted === room.players.size) doReveal(code); // auto reveal when all voted
  });

  // Manual reveal
  socket.on('round:reveal', ({ code }) => {
    const room = rooms.get(code);
    if (!room || room.host !== socket.id) return;
    doReveal(code);
  });

  // Leave / disconnect
  function removeFromRoom(rCode, id) {
    const room = rooms.get(rCode);
    if (!room) return;
    room.players.delete(id);
    if (room.host === id) room.host = null;

    // Adjust turn order if needed
    if (room.order?.length) {
      const oldIdx = room.order.findIndex(x => x === id);
      if (oldIdx >= 0) room.order.splice(oldIdx,1);
      if (room.currentTurn === id) {
        if (room.order.length) {
          room.currentTurn = room.order[oldIdx % room.order.length];
          io.to(rCode).emit('turn:state', { currentTurn: room.currentTurn, order: room.order });
        } else {
          room.currentTurn = null; room.turnsRemaining = 0;
        }
      }
    }

    emitUpdate(rCode);
    if (room.players.size === 0) { stopTimer(rCode); rooms.delete(rCode); }
  }

  socket.on('room:leave', () => {
    if (!currentRoom) return;
    removeFromRoom(currentRoom, socket.id);
    socket.leave(currentRoom);
    currentRoom = null;
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    removeFromRoom(currentRoom, socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
