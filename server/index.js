import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors());
app.get('/', (_, res) => res.send('Signaling server is running'));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN?.split(',') || '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
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
      socket.to(roomId).emit('peer-left', socket.id);
    });

  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Signaling listening on :${PORT}`));
