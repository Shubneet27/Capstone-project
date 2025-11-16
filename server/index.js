import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();

// FULL CORS ALLOW
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
}));

// ROOT ROUTE
app.get('/', (_, res) => res.send('Signaling server is running'));

// HEALTH CHECK (REQUIRED FOR RENDER)
app.get('/healthz', (_, res) => res.send("OK"));

const server = http.createServer(app);

// --------------------------------------------------------
// 100% WORKING SOCKET.IO CONFIG FOR RENDER
// --------------------------------------------------------
const io = new Server(server, {
  path: "/socket.io/",        // DO NOT REMOVE TRAILING SLASH
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["polling", "websocket"], // POLLING FIRST = REQUIRED FOR RENDER
});

// --------------------------------------------------------

io.on('connection', (socket) => {
  console.log("Client connected:", socket.id);

  socket.on('join-room', ({ roomId, displayName }) => {
    socket.join(roomId);

    const clients = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
    socket.emit('room-peers', clients.filter(id => id !== socket.id));

    socket.to(roomId).emit('peer-joined', {
      peerId: socket.id,
      displayName
    });

    socket.on('signal', ({ target, data }) => {
      io.to(target).emit('signal', {
        from: socket.id,
        data
      });
    });

    socket.on('leave-room', () => {
      socket.leave(roomId);
      socket.to(roomId).emit('peer-left', socket.id);
    });

    socket.on('disconnect', () => {
      console.log("Client disconnected:", socket.id);
      socket.to(roomId).emit('peer-left', socket.id);
    });

  });
});

// --------------------------------------------------------

const PORT = process.env.PORT || 8080;
server.listen(PORT, () =>
  console.log(`Signaling server running on port ${PORT}`)
);
