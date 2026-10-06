const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./orkut.db', (err) => {
  if (err) console.error('Erro ao abrir o banco', err.message);
  else console.log('Banco SQLite conectado.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    nick TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    photo TEXT DEFAULT '',
    scraps TEXT DEFAULT '[]',
    testimonials TEXT DEFAULT '[]'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS friendships (
    user_nick TEXT,
    friend_nick TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    category TEXT,
    language TEXT,
    type TEXT,
    location TEXT,
    owner_nick TEXT,
    photo TEXT DEFAULT '',
    created_date TEXT,
    members TEXT DEFAULT '[]'
  )`);
});

// Auth
app.post('/api/register', async (req, res) => {
  const { name, nick, email, password } = req.body;
  if (!name || !nick || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos!' });
  const hashedPassword = await bcrypt.hash(password, 8);

  db.run(`INSERT INTO users (name, nick, email, password, photo) VALUES (?, ?, ?, ?, ?)`,
    [name, nick, email, hashedPassword, 'https://via.placeholder.com/150'],
    function(err) {
      if (err) return res.status(400).json({ error: 'Nick ou E-mail já existem!' });
      res.json({ success: true });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Utilizador não encontrado!' });
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: 'Senha incorreta!' });
    res.json({ success: true, user: { id: user.id, name: user.name, nick: user.nick, photo: user.photo } });
  });
});

// Perfil
app.get('/api/user/:nick', (req, res) => {
  const nick = req.params.nick;
  db.get(`SELECT id, name, nick, email, photo, scraps, testimonials FROM users WHERE nick = ?`, [nick], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Utilizador não encontrado.' });
    user.scraps = JSON.parse(user.scraps || '[]');
    user.testimonials = JSON.parse(user.testimonials || '[]');

    db.all(`SELECT friend_nick FROM friendships WHERE user_nick = ?`, [nick], (err, friends) => {
      user.friends = friends.map(f => f.friend_nick);
      db.all(`SELECT id, name, members FROM communities`, [], (err, allComms) => {
        user.communities = allComms.filter(c => {
          let mems = JSON.parse(c.members || '[]');
          return mems.includes(nick);
        }).map(c => ({ id: c.id, name: c.name }));
        res.json(user);
      });
    });
  });
});

// Atualizar foto de perfil
app.post('/api/user/photo', (req, res) => {
  const { nick, photo } = req.body;
  db.run(`UPDATE users SET photo = ? WHERE nick = ?`, [photo, nick], () => {
    res.json({ success: true });
  });
});

// Recados com suporte a mídia (foto/vídeo)
app.post('/api/scrap', (req, res) => {
  const { targetNick, authorNick, message, mediaUrl } = req.body;
  db.get(`SELECT scraps FROM users WHERE nick = ?`, [targetNick], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Erro' });
    let scraps = JSON.parse(row.scraps || '[]');
    scraps.unshift({ authorNick, message, mediaUrl: mediaUrl || '', date: new Date().toLocaleDateString() });
    db.run(`UPDATE users SET scraps = ? WHERE nick = ?`, [JSON.stringify(scraps), targetNick], () => res.json({ success: true }));
  });
});

// Amigos
app.post('/api/friend/add', (req, res) => {
  const { userNick, friendNick } = req.body;
  if (userNick === friendNick) return res.status(400).json({ error: 'Não pode adicionar-se a si próprio.' });
  db.get(`SELECT * FROM users WHERE nick = ?`, [friendNick], (err, user) => {
    if (!user) return res.status(404).json({ error: 'Amigo não encontrado!' });
    db.run(`INSERT INTO friendships (user_nick, friend_nick) VALUES (?, ?)`, [userNick, friendNick], () => {
      db.run(`INSERT INTO friendships (user_nick, friend_nick) VALUES (?, ?)`, [friendNick, userNick], () => res.json({ success: true }));
    });
  });
});

// Comunidades Completas
app.get('/api/communities', (req, res) => {
  db.all(`SELECT * FROM communities`, [], (err, rows) => {
    const comms = rows.map(r => ({ ...r, members: JSON.parse(r.members || '[]') }));
    res.json(comms);
  });
});

app.post('/api/community/create', (req, res) => {
  const { name, description, category, language, type, location, ownerNick, photo } = req.body;
  const members = JSON.stringify([ownerNick]);
  const createdDate = new Date().toLocaleDateString();
  db.run(`INSERT INTO communities (name, description, category, language, type, location, owner_nick, photo, created_date, members) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, description, category, language || 'Português (Brasil)', type || 'pública', location || 'Brasil', ownerNick, photo || 'https://via.placeholder.com/120', createdDate, members], function(err) {
      if (err) return res.status(400).json({ error: 'Erro ao criar comunidade' });
      res.json({ success: true, id: this.lastID });
    });
});

app.post('/api/community/join', (req, res) => {
  const { communityId, userNick } = req.body;
  db.get(`SELECT members FROM communities WHERE id = ?`, [communityId], (err, row) => {
    if (!row) return res.status(404).json({ error: 'Comunidade não encontrada' });
    let members = JSON.parse(row.members || '[]');
    if (!members.includes(userNick)) members.push(userNick);
    db.run(`UPDATE communities SET members = ? WHERE id = ?`, [JSON.stringify(members), communityId], () => res.json({ success: true }));
  });
});

io.on('connection', (socket) => {
  socket.on('join_room', (room) => socket.join(room));
  socket.on('send_message', (data) => io.to(data.room).emit('receive_message', data));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Orkut clássico a rodar na porta ${PORT}`));
