const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let games = {}; // Global database matrix holding match structures

// Helper logic: Broadcast live rooms directory overview to everyone in the lobby
function broadcastGameDirectory() {
    const list = Object.keys(games).map(id => ({
        id: id,
        name: games[id].gameName,
        hasP2: !!games[id].p2,
        hasPassword: !!games[id].password,
        specCount: games[id].spectators.length
    }));
    io.emit('gameListUpdate', list);
}

// Server-side win verification system to ensure game rules are respected
function checkWin(board, r, c) {
    const p = board[r][c];
    // Direction vectors: [row_offset, col_offset]
    const directions = [
        [[0, 1], [0, -1]],   // Horizontal
        [[1, 0], [-1, 0]],   // Vertical
        [[1, 1], [-1, -1]],  // Diagonal down-right
        [[1, -1], [-1, 1]]   // Diagonal down-left
    ];

    for (const dir of directions) {
        let count = 1; // Count the piece just placed
        
        for (const [dr, dc] of dir) {
            let stepR = r + dr;
            let stepC = c + dc;
            
            // Track matches continuously in one direction line
            while (stepR >= 0 && stepR < 6 && stepC >= 0 && stepC < 7 && board[stepR][stepC] === p) {
                count++;
                stepR += dr;
                stepC += dc;
            }
        }
        if (count >= 4) return true;
    }
    return false;
}
io.on('connection', (socket) => {
    // Send structural room list to user immediately upon connecting
    const list = Object.keys(games).map(id => ({
        id: id, name: games[id].gameName, hasP2: !!games[id].p2,
        hasPassword: !!games[id].password, specCount: games[id].spectators.length
    }));
    socket.emit('gameListUpdate', list);

    // Event: User creates a new game room
    socket.on('createGame', (data) => {
        const gameId = `game_${Date.now()}`;
        games[gameId] = {
            gameName: data.gameName,
            password: data.password || null,
            p1: socket.id, p1Name: data.name, p1Score: 0,
            p2: null, p2Name: null, p2Score: 0,
            spectators: [],
            board: Array(6).fill(null).map(() => Array(7).fill(0)),
            currentPlayer: 1,
            gameActive: false
        };
        
        socket.gameId = gameId;
        socket.join(gameId);
        socket.emit('joinSuccess', { playerNum: 1, p1Name: data.name });
        broadcastGameDirectory();
    });

    // Event: User joins an existing game room (as Player 2 or Spectator)
    socket.on('joinGame', (data) => {
        const g = games[data.gameId];
        if (!g) {
            socket.emit('joinFailure', 'Game room no longer exists!');
            return;
        }

        // Verify password if one is set
        if (g.password && g.password !== data.password) {
            socket.emit('joinFailure', 'Incorrect game password!');
            return;
        }

        socket.gameId = data.gameId;
        socket.join(data.gameId);

        if (!g.p2) {
            // Assign as Player 2
            g.p2 = socket.id;
            g.p2Name = data.name;
            g.gameActive = true; 
            socket.emit('joinSuccess', { playerNum: 2, p1Name: g.p1Name, p2Name: g.p2Name });
        } else {
            // Assign as Spectator
            g.spectators.push(socket.id);
            socket.emit('joinSuccess', { playerNum: 0, p1Name: g.p1Name, p2Name: g.p2Name });
        }

        // Broadcast updated state to everyone in the room
        io.to(data.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
        });
        broadcastGameDirectory();
    });

    // Event: Player drops a chip into a column
    socket.on('playerActionMove', (data) => {
        const g = games[socket.gameId];
        if (!g || !g.gameActive) return;

        // Verify it is actually this player's turn
        const senderNum = g.p1 === socket.id ? 1 : (g.p2 === socket.id ? 2 : 0);
        if (senderNum !== g.currentPlayer || senderNum === 0) return;

        let targetRow = -1;
        for (let r = 5; r >= 0; r--) {
            if (g.board[r][data.col] === 0) {
                targetRow = r;
                break;
            }
        }
        if (targetRow === -1) return; // Column full

        g.board[targetRow][data.col] = g.currentPlayer;

        if (checkWin(g.board, targetRow, data.col)) {
            if (g.currentPlayer === 1) g.p1Score++; else g.p2Score++;
            g.gameActive = false;
            io.to(socket.gameId).emit('gameStateUpdate', {
                board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
                p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
            });
            io.to(socket.gameId).emit('gameFinished', { type: 'win', winner: g.currentPlayer });
            return;
        }

        if (g.board.every(row => row.every(cell => cell !== 0))) {
            g.gameActive = false;
            io.to(socket.gameId).emit('gameStateUpdate', {
                board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
                p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
            });
            io.to(socket.gameId).emit('gameFinished', { type: 'draw' });
            return;
        }

        // Switch turns
        g.currentPlayer = g.currentPlayer === 1 ? 2 : 1;
        io.to(socket.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
        });
    });

    // Event: Request a match reset
    socket.on('requestMatchReset', () => {
        const g = games[socket.gameId];
        if (!g || (g.p1 !== socket.id && g.p2 !== socket.id)) return;

        g.board = Array(6).fill(null).map(() => Array(7).fill(0));
        g.currentPlayer = 1;
        g.gameActive = !!(g.p1 && g.p2);

        io.to(socket.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
        });
        io.to(socket.gameId).emit('gameRestarted');
    });

    // Event: Disconnect handling and cleanup
    socket.on('disconnect', () => {
        const gId = socket.gameId;
        const g = games[gId];
        if (g) {
            if (g.p1 === socket.id || g.p2 === socket.id) {
                // If a primary player leaves, notify remaining connections and delete the room
                io.to(gId).emit('opponentDisconnected');
                delete games[gId];
            } else {
                // If a spectator leaves, remove them from tracking array
                g.spectators = g.spectators.filter(id => id !== socket.id);
                io.to(gId).emit('gameStateUpdate', {
                    board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
                    p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
                });
            }
            broadcastGameDirectory();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
