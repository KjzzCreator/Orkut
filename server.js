const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Banco de Dados SQLite
const db = new sqlite3.Database('./orkut.db', (err) => {
  if (err) console.error('Erro ao abrir o banco de dados', err.message);
  else console.log('Conectado ao banco de dados SQLite.');
});

// Criar Tabelas
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    nick TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    scraps TEXT DEFAULT '[]',
    testimonials TEXT DEFAULT '[]'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS friendships (
    user_nick TEXT,
    friend_nick TEXT,
    status TEXT
  )`);
});

// Rotas de Autenticação
app.post('/api/register', async (req, res) => {
  const { name, nick, email, password } = req.body;
  if (!name || !nick || !email || !password) {
    return res.status(400).json({ error: 'Preencha todos os campos!' });
  }

  const hashedPassword = await bcrypt.hash(password, 8);

  db.run(`INSERT INTO users (name, nick, email, password) VALUES (?, ?, ?, ?)`,
    [name, nick, email, hashedPassword],
    function(err) {
      if (err) {
        return res.status(400).json({ error: 'Nick ou E-mail já cadastrados!' });
      }
      res.json({ success: true, message: 'Usuário registrado com sucesso!' });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'Usuário não encontrado!' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ error: 'Senha incorreta!' });

    res.json({ success: true, user: { id: user.id, name: user.name, nick: user.nick } });
  });
});

// Rota para buscar perfil por nick
app.get('/api/user/:nick', (req, res) => {
  const nick = req.params.nick;
  db.get(`SELECT id, name, nick, email, scraps, testimonials FROM users WHERE nick = ?`, [nick], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    
    user.scraps = JSON.parse(user.scraps || '[]');
    user.testimonials = JSON.parse(user.testimonials || '[]');

    // Buscar amigos
    db.all(`SELECT friend_nick FROM friendships WHERE user_nick = ? AND status = 'accepted'`, [nick], (err, friends) => {
      user.friends = friends.map(f => f.friend_nick);
      res.json(user);
    });
  });
});

// Enviar Recado (Scrap)
app.post('/api/scrap', (req, res) => {
  const { targetNick, authorNick, message } = req.body;
  db.get(`SELECT scraps FROM users WHERE nick = ?`, [targetNick], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    let scraps = JSON.parse(row.scraps || '[]');
    scraps.unshift({ authorNick, message, date: new Date().toLocaleDateString() });

    db.run(`UPDATE users SET scraps = ? WHERE nick = ?`, [JSON.stringify(scraps), targetNick], () => {
      res.json({ success: true });
    });
  });
});

// Adicionar Amigo
app.post('/api/friend/add', (req, res) => {
  const { userNick, friendNick } = req.body;
  if (userNick === friendNick) return res.status(400).json({ error: 'Você não pode se adicionar.' });

  db.get(`SELECT * FROM users WHERE nick = ?`, [friendNick], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'Amigo não encontrado pelo nick!' });

    db.run(`INSERT INTO friendships (user_nick, friend_nick, status) VALUES (?, ?, 'accepted')`, [userNick, friendNick], () => {
      db.run(`INSERT INTO friendships (user_nick, friend_nick, status) VALUES (?, ?, 'accepted')`, [friendNick, userNick], () => {
        res.json({ success: true });
      });
    });
  });
});

// WebSockets para Chat em Tempo Real
io.on('connection', (socket) => {
  socket.on('join_room', (room) => {
    socket.join(room);
  });

  socket.on('send_message', (data) => {
    io.to(data.room).emit('receive_message', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));