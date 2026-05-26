const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let rooms = {}; 

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Wait until user enters their name on the UI screen
    socket.on('registerPlayer', (userData) => {
        let roomId = Object.keys(rooms).find(id => !rooms[id].p2);

        if (!roomId) {
            roomId = `room_${socket.id}`;
            rooms[roomId] = { 
                p1: socket.id, p1Name: userData.name, 
                p2: null, p2Name: null 
            };
        } else {
            rooms[roomId].p2 = socket.id;
            rooms[roomId].p2Name = userData.name;
        }

        socket.join(roomId);
        socket.roomId = roomId;

        const playerNum = rooms[roomId].p1 === socket.id ? 1 : 2;
        socket.emit('assignPlayer', { playerNum: playerNum, roomId: roomId });

        // If the room is now full, broadcast names to both sides to start the game
        if (rooms[roomId].p1 && rooms[roomId].p2) {
            io.to(roomId).emit('gameReady', {
                p1Name: rooms[roomId].p1Name,
                p2Name: rooms[roomId].p2Name
            });
        }
    });

    socket.on('makeMove', (data) => {
        socket.to(socket.roomId).emit('moveMade', data);
    });

    socket.on('resetGame', () => {
        io.to(socket.roomId).emit('gameRestarted');
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const rId = socket.roomId;
        if (rooms[rId]) {
            if (rooms[rId].p1 === socket.id) rooms[rId].p1 = null;
            if (rooms[rId].p2 === socket.id) rooms[rId].p2 = null;
            
            if (!rooms[rId].p1 && !rooms[rId].p2) {
                delete rooms[rId];
            } else {
                io.to(rId).emit('opponentLeft');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
