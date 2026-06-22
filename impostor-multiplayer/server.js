const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const { v4: uuid } = require('uuid');
const path = require('path');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, 'public')));

const TOPICS = {
  animals:    { icon:'🐾', words:['dog','cat','elephant','sheep','shark','snake','giraffe','wolf','lion','dolphin','zebra','crocodile'] },
  fruits:     { icon:'🍉', words:['mango','apple','watermelon','grape','pineapple','banana','papaya','durian','guava','lychee','dragonfruit'] },
  countries:  { icon:'🌍', words:['Japan','Brazil','Ethiopia','Canada','Australia','Egypt','Norway','Mexico','Nigeria','Thailand','Argentina','Sweden'] },
  sports:     { icon:'⚽', words:['soccer','tennis','swimming','boxing','basketball','cycling','rugby','golf','volleyball','archery','fencing','sumo'] },
  movies:     { icon:'🎬', words:['Titanic','Spider-Man','Minions','Avatar','Joker','Dune','Zootopia','Frozen','Goat','Gladiator','Matrix'] },
  foods:      { icon:'🍕', words:['pizza','Ktfo','pasta','burger','injera','shiro','beg tbs','doro','gomen','biryani','water'] },
  jobs:       { icon:'💼', words:['teacher','doctor','pilot','chef','lawyer','engineer','farmer','musician','astronaut','spy','firefighter','surgeon'] },
  colors:     { icon:'🎨', words:['crimson','red','black','white','green','blue','yellow','olive','magenta','cobalt','teal','vermillion'] },
  vehicles:   { icon:'🚀', words:['motorcycle','submarine','helicopter','tractor','speedboat','tram','rocket','skateboard','zeppelin','hovercraft','gondola','snowmobile'] },
  superheroes:{ icon:'🦸', words:['Spider-Man','Batman','Wonder Woman','Thor','Black Panther','Hulk','Flash','Superman','Deadpool','Aquaman','Iron Man','Wolverine'] },
  music:      { icon:'🎵', words:['guitar','piano','drums','violin','trumpet','saxophone'] },
  nature:     { icon:'🌿', words:['volcano','glacier','rainforest','desert','coral reef','waterfall','canyon','tundra','savanna','mangrove','geyser','fjord'] },
  girls:      { icon:'👧', words:['Saron 😍','Bitaniya (mia)','Leah (Shele one)','Melkam (Ahh)','Emrachel 😘','Maleda 🤢','Amal 🍑','Awnan 🍒','FeVen 👩🏿','FeBen (KSI)'] },
};

const rooms = {};
const clients = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function impostorCount(n) { return n <= 4 ? 1 : n <= 8 ? 2 : 3; }

function safeSend(ws, msg) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch(e) {}
}

function broadcastAll(room, msg) {
  room.players.forEach(p => safeSend(p.ws, msg));
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    host: room.host,
    topic: room.topic,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    timerDuration: room.timerDuration,
    crewWins: room.crewWins,
    impWins: room.impWins,
    verdict: room.verdict || null,
    theWord: (room.phase === 'verdict' || room.phase === 'scoreboard') ? room.theWord : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      connected: p.connected,
      voted: p.voted,
      ready: p.ready,
    })),
  };
}

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function startVoting(room) {
  stopTimer(room);
  room.phase = 'voting';
  room.players.forEach(p => { p.voted = false; });
  room.votes = {};
  broadcastAll(room, { type: 'phase', phase: 'voting', state: publicState(room) });
}

function resolveVotes(room) {
  const tally = {};
  room.players.forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(v => { if (v && tally[v] !== undefined) tally[v]++; });
  const maxV = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter(k => tally[k] === maxV && maxV > 0);
  const eliminatedId = top.length ? top[Math.floor(Math.random() * top.length)] : null;
  const elimPlayer = eliminatedId ? room.players.find(p => p.id === eliminatedId) : null;
  const caught = !!(elimPlayer && elimPlayer.isImpostor);

  if (caught) {
    room.crewWins++;
    room.players.forEach(p => { if (!p.isImpostor) p.score += 3; });
    room.verdict = { result: 'crew_win', eliminatedId, caught: true, eliminatedName: elimPlayer ? elimPlayer.name : '' };
  } else {
    room.impWins++;
    room.impostors.forEach(id => {
      const p = room.players.find(x => x.id === id);
      if (p) p.score += 4;
    });
    room.verdict = { result: 'imp_win', eliminatedId, caught: false, eliminatedName: elimPlayer ? elimPlayer.name : '' };
  }

  room.phase = 'verdict';
  broadcastAll(room, { type: 'phase', phase: 'verdict', state: publicState(room) });
}

function assignRoles(room) {
  const n = room.players.length;
  const numImp = impostorCount(n);
  const impIdxs = new Set(shuffle([...Array(n).keys()]).slice(0, numImp));
  const topicData = TOPICS[room.topic] || TOPICS['animals'];
  const word = topicData.words[Math.floor(Math.random() * topicData.words.length)];
  room.theWord = word;
  room.impostors = [];
  room.players.forEach((p, i) => {
    p.isImpostor = impIdxs.has(i);
    p.voted = false;
    p.ready = false;
    if (p.isImpostor) room.impostors.push(p.id);
  });
  room.votes = {};
}

function sendRoles(room) {
  room.players.forEach(p => {
    safeSend(p.ws, {
      type: 'yourRole',
      isImpostor: p.isImpostor,
      word: p.isImpostor ? null : room.theWord,
      topic: room.topic,
      state: publicState(room),
    });
  });
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // CREATE
    if (msg.type === 'create') {
      let code = genCode();
      while (rooms[code]) code = genCode();
      const playerId = uuid();
      const room = {
        code, host: playerId, phase: 'lobby',
        topic: 'animals', totalRounds: 3, currentRound: 1,
        timerDuration: 60, timerInterval: null, timerPaused: false,
        players: [], votes: {}, impostors: [],
        crewWins: 0, impWins: 0, verdict: null, theWord: '',
      };
      room.players.push({ id: playerId, ws, name: msg.name || 'Host', avatar: msg.avatar || '🧑', score: 0, connected: true, isImpostor: false, voted: false, ready: false });
      rooms[code] = room;
      clients.set(ws, { roomCode: code, playerId });
      const topicList = Object.entries(TOPICS).map(([k, v]) => ({ id: k, label: k, icon: v.icon }));
      safeSend(ws, { type: 'joined', playerId, roomCode: code, state: publicState(room), topics: topicList });
      return;
    }

    // JOIN
    if (msg.type === 'join') {
      const code = (msg.code || '').trim().toUpperCase();
      const room = rooms[code];
      if (!room) { safeSend(ws, { type: 'error', msg: 'Room not found!' }); return; }
      if (room.phase !== 'lobby') { safeSend(ws, { type: 'error', msg: 'Game already started!' }); return; }
      if (room.players.length >= 15) { safeSend(ws, { type: 'error', msg: 'Room is full!' }); return; }
      const playerId = uuid();
      room.players.push({ id: playerId, ws, name: msg.name || `Player ${room.players.length + 1}`, avatar: msg.avatar || '🧑', score: 0, connected: true, isImpostor: false, voted: false, ready: false });
      clients.set(ws, { roomCode: code, playerId });
      const topicList = Object.entries(TOPICS).map(([k, v]) => ({ id: k, label: k, icon: v.icon }));
      safeSend(ws, { type: 'joined', playerId, roomCode: code, state: publicState(room), topics: topicList });
      broadcastAll(room, { type: 'update', state: publicState(room) });
      return;
    }

    const ctx = clients.get(ws);
    if (!ctx) return;
    const room = rooms[ctx.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === ctx.playerId);
    if (!player) return;
    const isHost = room.host === ctx.playerId;

    if (msg.type === 'settings' && isHost && room.phase === 'lobby') {
      if (msg.topic) room.topic = msg.topic;
      if (msg.totalRounds) room.totalRounds = Number(msg.totalRounds);
      if (msg.timerDuration !== undefined) room.timerDuration = Number(msg.timerDuration);
      broadcastAll(room, { type: 'update', state: publicState(room) });
    }

    if (msg.type === 'startGame' && isHost && room.phase === 'lobby') {
      if (room.players.length < 3) { safeSend(ws, { type: 'error', msg: 'Need at least 3 players!' }); return; }
      room.phase = 'roles';
      room.currentRound = 1;
      room.crewWins = 0; room.impWins = 0;
      room.players.forEach(p => { p.score = 0; });
      assignRoles(room);
      sendRoles(room);
      broadcastAll(room, { type: 'update', state: publicState(room) });
    }

    if (msg.type === 'ready' && room.phase === 'roles') {
      player.ready = true;
      broadcastAll(room, { type: 'update', state: publicState(room) });
      if (room.players.every(p => p.ready)) {
        room.phase = 'discussion';
        broadcastAll(room, { type: 'phase', phase: 'discussion', state: publicState(room) });
        if (room.timerDuration > 0) {
          room.timerLeft = room.timerDuration;
          room.timerPaused = false;
          room.timerInterval = setInterval(() => {
            if (room.timerPaused) return;
            room.timerLeft--;
            broadcastAll(room, { type: 'timer', val: room.timerLeft });
            if (room.timerLeft <= 0) { stopTimer(room); startVoting(room); }
          }, 1000);
        }
      }
    }

    if (msg.type === 'pauseTimer' && isHost) {
      room.timerPaused = !room.timerPaused;
      broadcastAll(room, { type: 'timerPaused', paused: room.timerPaused });
    }

    if (msg.type === 'skipTimer' && isHost) { stopTimer(room); startVoting(room); }

    if (msg.type === 'vote' && room.phase === 'voting' && !player.voted) {
      player.voted = true;
      room.votes[player.id] = msg.targetId || null;
      broadcastAll(room, { type: 'update', state: publicState(room) });
      if (room.players.every(p => p.voted)) resolveVotes(room);
    }

    if (msg.type === 'nextRound' && isHost && room.phase === 'verdict') {
      if (room.currentRound >= room.totalRounds) {
        room.phase = 'scoreboard';
        broadcastAll(room, { type: 'phase', phase: 'scoreboard', state: publicState(room) });
      } else {
        room.currentRound++;
        room.phase = 'roles';
        assignRoles(room);
        sendRoles(room);
        broadcastAll(room, { type: 'update', state: publicState(room) });
      }
    }

    if (msg.type === 'endGame' && isHost) {
      room.phase = 'scoreboard';
      broadcastAll(room, { type: 'phase', phase: 'scoreboard', state: publicState(room) });
    }

    if (msg.type === 'chat') {
      const text = (msg.text || '').trim().slice(0, 200);
      if (!text) return;
      broadcastAll(room, { type: 'chat', playerId: player.id, name: player.name, avatar: player.avatar, text, time: Date.now() });
    }

    if (msg.type === 'restart' && isHost) {
      stopTimer(room);
      room.phase = 'lobby'; room.currentRound = 1;
      room.crewWins = 0; room.impWins = 0; room.votes = {}; room.verdict = null; room.theWord = '';
      room.players.forEach(p => { p.score = 0; p.isImpostor = false; p.voted = false; p.ready = false; });
      broadcastAll(room, { type: 'phase', phase: 'lobby', state: publicState(room) });
    }
  });

  ws.on('close', () => {
    const ctx = clients.get(ws);
    if (!ctx) return;
    clients.delete(ws);
    const room = rooms[ctx.roomCode];
    if (!room) return;
    const p = room.players.find(p => p.id === ctx.playerId);
    if (p) p.connected = false;
    broadcastAll(room, { type: 'update', state: publicState(room) });
    if (!room.players.some(p => p.connected)) setTimeout(() => { delete rooms[ctx.roomCode]; }, 600000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Impostor Game running on port ' + PORT));
