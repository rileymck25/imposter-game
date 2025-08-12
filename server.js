const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('web'));
app.use(express.json());

const WORD_LISTS = {
  classic: ['apple','jupiter','guitar','ocean','pyramid','subway','volcano','pancake','tornado','compass','castle'],
  disney:  ['Cinderella','Epcot','Imagineer','Monorail','Dole Whip','Haunted Mansion','Tinker Bell','Fantasia','Skyliner'],
  tech:    ['firewall','container','webhook','endpoint','kernel','router','timestamp','payload','virtualization'],
  food:    ['lasagna','sushi','taco','croissant','ramen','gelato','barbecue','dumpling','paella']
};
const pick = a => a[Math.floor(Math.random()*a.length)];
const norm = s => String(s||'').trim().toLowerCase().replace(/\s+/g,' ');

const rooms = new Map();
const timers = new Map();

const ensureRoom = (code) => {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code, host: null, players: new Map(),
      topic: null, phase: 'lobby',
      secretWord: null,
      timerSec: 90, voteTimerSec: 25,
      roundNumber: 0, order: [], startIndex: 0,
      currentTurn: null, turnsRemaining: 0
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
const emitUpdate = (code) => { const r=rooms.get(code); if(r) io.to(code).emit('room:update', publicState(r)); };
const stopTimer = (code) => { const t = timers.get(code); if (t?.interval) clearInterval(t.interval); timers.delete(code); };

function broadcastTally(room){
  const tally = {}; let voted = 0;
  for (const [,p] of room.players) if (p.voteFor) { tally[p.voteFor] = (tally[p.voteFor]||0)+1; voted++; }
  io.to(room.code).emit('vote:update', { tally, total: room.players.size });
  return { tally, voted };
}
function enterVote(code){
  const room=rooms.get(code); if(!room) return;
  stopTimer(code);
  room.phase='vote';
  for (const [,p] of room.players){ p.voteFor=null; p.guessed=false; }
  room.currentTurn=null; room.turnsRemaining=0;
  emitUpdate(code);
  const endsAt = Date.now()+(room.voteTimerSec||25)*1000;
  const interval = setInterval(()=>{
    const ms=Math.max(0, endsAt-Date.now()), secs=Math.ceil(ms/1000);
    io.to(code).emit('timer:tick', { secs });
    if(ms<=0){ stopTimer(code); doReveal(code); }
  },250);
  timers.set(code,{interval,endsAt,kind:'vote'});
  broadcastTally(room);
}
function doReveal(code, jailbreak=null){
  const room=rooms.get(code); if(!room) return;
  stopTimer(code);
  if(jailbreak?.success){
    room.phase='reveal';
    io.to(code).emit('round:results', {
      executed:null, isHit:false,
      imposters:Array.from(room.players.entries()).filter(([id,p])=>p.isImposter).map(([id])=>id),
      secret:room.secretWord,
      jailbreak:{by:jailbreak.by, word:room.secretWord}
    });
    emitUpdate(code); return;
  }
  const votes={}; for(const [,p] of room.players) if(p.voteFor) votes[p.voteFor]=(votes[p.voteFor]||0)+1;
  let executed=null, max=-1; for(const [pid,c] of Object.entries(votes)){ if(c>max){max=c; executed=pid;} }
  const executedPlayer = executed? room.players.get(executed) : null;
  const imposters = Array.from(room.players.entries()).filter(([id,p])=>p.isImposter).map(([id])=>id);
  const isHit = executed ? !!executedPlayer?.isImposter : false;
  room.phase='reveal';
  io.to(code).emit('round:results', { executed:executed||null, isHit, imposters, secret:room.secretWord });
  emitUpdate(code);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:create', ({ code, name }) => {
    const room = ensureRoom(code);
    room.host = socket.id;
    room.players.set(socket.id, { name: name || 'Host' });
    socket.join(code); currentRoom=code; emitUpdate(code);
  });
  socket.on('room:join', ({ code, name }) => {
    const room = ensureRoom(code);
    room.players.set(socket.id, { name: name || 'Player' });
    socket.join(code); currentRoom=code; emitUpdate(code);
  });
  socket.on('room:sync', ({ code }) => emitUpdate(code));

  socket.on('role:remind', ({ code }) => {
    const r=rooms.get(code); if(!r) return;
    const p=r.players.get(socket.id); if(!p) return;
    io.to(socket.id).emit('role:assign',{topic:r.topic||'classic', isImposter:!!p.isImposter, word:p.word||null});
  });

  socket.on('topic:set', ({ code, topic }) => {
    const room=rooms.get(code); if(!room||room.host!==socket.id) return;
    const key=String(topic||'').toLowerCase();
    room.topic=['classic','disney','tech','food'].includes(key)?key:'classic';
    room.phase='lobby'; room.secretWord=null; room.currentTurn=null; room.turnsRemaining=0;
    for (const [,p] of room.players){ delete p.isImposter; delete p.word; delete p.voteFor; delete p.guessed; }
    emitUpdate(code);
  });
  socket.on('timer:set', ({code,seconds}) => { const r=rooms.get(code); if(!r||r.host!==socket.id) return; const s=Math.floor(Number(seconds)); if(s>=10&&s<=600){ r.timerSec=s; emitUpdate(code); }});
  socket.on('voteTimer:set', ({code,seconds}) => { const r=rooms.get(code); if(!r||r.host!==socket.id) return; const s=Math.floor(Number(seconds)); if(s>=5&&s<=180){ r.voteTimerSec=s; emitUpdate(code); }});

  socket.on('round:deal', ({ code }) => {
    const room=rooms.get(code); if(!room||room.host!==socket.id) return;
    const ids=Array.from(room.players.keys());
    if(ids.length<3){ io.to(socket.id).emit('round:error',{reason:'not_enough_players',need:3,have:ids.length}); return; }
    const list = WORD_LISTS[room.topic||'classic'] || WORD_LISTS.classic;
    room.secretWord = pick(list);
    const imposterId = ids[Math.floor(Math.random()*ids.length)];
    for (const [id,p] of room.players){
      const isImp=id===imposterId;
      p.isImposter=isImp; p.word=isImp?null:room.secretWord; p.voteFor=null; p.guessed=false;
      io.to(id).emit('role:assign',{topic:room.topic||'classic', isImposter:isImp, word:isImp?null:room.secretWord});
    }
    room.order=Array.from(room.players.keys());
    room.roundNumber=(room.roundNumber||0)+1;
    room.startIndex=(room.roundNumber-1)%room.order.length;
    room.currentTurn=null; room.turnsRemaining=0;
    room.phase='roles'; stopTimer(code); emitUpdate(code);
  });

  socket.on('round:discuss', ({ code }) => {
    const room=rooms.get(code); if(!room||room.host!==socket.id) return;

    // NEW: enforce min players and auto-deal roles if needed
    if (room.players.size < 3) { io.to(socket.id).emit('round:error',{reason:'not_enough_players',need:3,have:room.players.size}); return; }
    if (!room.secretWord) {
      // auto-deal then start
      const ids=Array.from(room.players.keys());
      const list = WORD_LISTS[room.topic||'classic'] || WORD_LISTS.classic;
      room.secretWord = pick(list);
      const imposterId = ids[Math.floor(Math.random()*ids.length)];
      for (const [id,p] of room.players){
        const isImp=id===imposterId;
        p.isImposter=isImp; p.word=isImp?null:room.secretWord; p.voteFor=null; p.guessed=false;
        io.to(id).emit('role:assign',{topic:room.topic||'classic', isImposter:isImp, word:isImp?null:room.secretWord});
      }
      room.order=Array.from(room.players.keys());
      room.roundNumber=(room.roundNumber||0)+1;
      room.startIndex=(room.roundNumber-1)%room.order.length;
      room.currentTurn=null; room.turnsRemaining=0;
    }

    room.phase='discuss';
    if(!room.order||room.order.length===0) room.order=Array.from(room.players.keys());
    room.turnsRemaining=room.order.length;
    room.currentTurn=room.order[room.startIndex];
    const orderWithNames = room.order.map(id => ({ id, name: room.players.get(id)?.name || 'Player' }));
    io.to(code).emit('turn:state',{ currentTurn: room.currentTurn, order: orderWithNames });
    emitUpdate(code);

    stopTimer(code);
    const endsAt = Date.now()+(room.timerSec||90)*1000;
    const interval = setInterval(()=>{
      const ms=Math.max(0, endsAt-Date.now()), secs=Math.ceil(ms/1000);
      io.to(code).emit('timer:tick',{secs});
      if(ms<=0){ stopTimer(code); enterVote(code); io.to(code).emit('timer:end'); }
    },250);
    timers.set(code,{interval,endsAt,kind:'discuss'});
  });

  socket.on('round:start-vote', ({ code }) => { const r=rooms.get(code); if(!r||r.host!==socket.id) return; enterVote(code); });

  socket.on('turn:submit', ({ code, word }) => {
    const r=rooms.get(code); if(!r||r.phase!=='discuss') return;
    const clean=String(word||'').trim().slice(0,40); if(!clean||socket.id!==r.currentTurn) return;
    const player=r.players.get(socket.id); io.to(code).emit('turn:word',{pid:socket.id,name:player?.name||'Player',text:clean});
    r.turnsRemaining=Math.max(0,(r.turnsRemaining||1)-1);
    if(r.turnsRemaining<=0) enterVote(code);
    else {
      const idx=r.order.findIndex(id=>id===r.currentTurn);
      const next=(idx+1)%r.order.length;
      r.currentTurn=r.order[next];
      const orderWithNames = r.order.map(id => ({ id, name: r.players.get(id)?.name || 'Player' }));
      io.to(code).emit('turn:state',{ currentTurn: r.currentTurn, order: orderWithNames });
      emitUpdate(code);
    }
  });

  socket.on('vote:cast', ({ code, targetId }) => {
    const r=rooms.get(code); if(!r||r.phase!=='vote') return;
    if(!r.players.has(targetId) || targetId===socket.id) return;
    const voter=r.players.get(socket.id); if(!voter) return;
    voter.voteFor=targetId;
    const {voted}=broadcastTally(r);
    if(voted===r.players.size) doReveal(code);
  });

  socket.on('imposter:guess', ({ code, guess }) => {
    const r=rooms.get(code); if(!r||r.phase!=='vote') return;
    const p=r.players.get(socket.id); if(!p?.isImposter || p.guessed) return;
    p.guessed=true;
    const ok = norm(guess)===norm(r.secretWord);
    if(ok) doReveal(code,{success:true,by:socket.id}); else io.to(socket.id).emit('guess:result',{ok:false});
  });

  socket.on('game:end', ({ code }) => {
    const r=rooms.get(code); if(!r||r.host!==socket.id) return;
    stopTimer(code); r.phase='ended'; emitUpdate(code); io.to(code).emit('game:ended');
  });
  socket.on('game:reset', ({ code }) => {
    const r=rooms.get(code); if(!r||r.host!==socket.id) return;
    stopTimer(code);
    r.phase='lobby'; r.secretWord=null; r.currentTurn=null; r.turnsRemaining=0;
    for(const [,p] of r.players){ delete p.isImposter; delete p.word; delete p.voteFor; delete p.guessed; }
    emitUpdate(code);
  });

  socket.on('dm:send', ({ code, to, text }) => {
    const r=rooms.get(code); if(!r) return;
    const fromP=r.players.get(socket.id); if(!fromP || !r.players.has(to)) return;
    const payload={ from:socket.id, to, name:fromP.name, text:String(text||'').slice(0,300), at:Date.now() };
    io.to(to).emit('dm:msg', payload);
    io.to(socket.id).emit('dm:msg', payload);
  });

  function removeFromRoom(rCode, id){
    const r=rooms.get(rCode); if(!r) return;
    r.players.delete(id);
    if(r.host===id) r.host=null;
    if(r.order?.length){
      const i=r.order.findIndex(x=>x===id); if(i>=0) r.order.splice(i,1);
      if(r.currentTurn===id){ r.currentTurn=r.order.length? r.order[i % r.order.length] : null; r.turnsRemaining=r.order.length? r.turnsRemaining : 0; }
    }
    emitUpdate(rCode); if(r.players.size===0){ stopTimer(rCode); rooms.delete(rCode); }
  }
  socket.on('room:leave', ()=>{ if(!currentRoom) return; removeFromRoom(currentRoom,socket.id); socket.leave(currentRoom); currentRoom=null; });
  socket.on('disconnect', ()=>{ if(!currentRoom) return; removeFromRoom(currentRoom,socket.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
