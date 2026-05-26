const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));

let players = {}; // Tracks connected socket IDs

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Assign player roles based on who joins first
    if (!players.p1) {
        players.p1 = socket.id;
        socket.emit('assignPlayer', { playerNum: 1 });
    } else if (!players.p2) {
        players.p2 = socket.id;
        socket.emit('assignPlayer', { playerNum: 2 });
    } else {
        socket.emit('assignPlayer', { playerNum: 0 }); // Spectator
    }

    // Handle incoming moves
    socket.on('makeMove', (data) => {
        // Broadcast the move to everyone else
        socket.broadcast.emit('moveMade', data);
    });

    // Handle game resets
    socket.on('resetGame', () => {
        io.emit('gameRestarted');
    });

    // Handle disconnects
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        if (players.p1 === socket.id) players.p1 = null;
        if (players.p2 === socket.id) players.p2 = null;
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
