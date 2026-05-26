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

function broadcastGameDirectory() {
    const list = Object.keys(games).map(id => ({
        id: id,
        name: games[id].gameName,
        hasP2: !!games[id].p2 || !!games[id].p2DisconnectedName, // Still counted as full if holding slot
        hasPassword: !!games[id].password,
        specCount: games[id].spectators.length
    }));
    io.emit('gameListUpdate', list);
}

function checkWin(board, r, c) {
    const p = board[r][c];
    const directions = [[,[0,-1]], [,[-1,0]], [,[-1,-1]], [[1,-1],[-1,1]]];
    for (const dir of directions) {
        let count = 1;
        for (const [dr, dc] of dir) {
            let sR = r + dr; let sC = c + dc;
            while (sR >= 0 && sR < 6 && sC >= 0 && sC < 7 && board[sR][sC] === p) {
                count++; sR += dr; sC += dc;
            }
        }
        if (count >= 4) return true;
    }
    return false;
}
io.on('connection', (socket) => {
    // Send structural room list to user immediately upon connecting
    broadcastGameDirectory();

    socket.on('createGame', (data) => {
        const gameId = `game_${Date.now()}`;
        games[gameId] = {
            gameName: data.gameName,
            password: data.password || null,
            p1: socket.id, p1Name: data.name, p1Score: 0, p1Timeout: null,
            p2: null, p2Name: null, p2Score: 0, p2Timeout: null,
            p1DisconnectedName: null, p2DisconnectedName: null, // Recovery flags
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

    socket.on('joinGame', (data) => {
        const g = games[data.gameId];
        if (!g) {
            socket.emit('joinFailure', 'Game room no longer exists!');
            return;
        }
        if (g.password && g.password !== data.password) {
            socket.emit('joinFailure', 'Incorrect game password!');
            return;
        }

        socket.gameId = data.gameId;
        socket.join(data.gameId);

        // RECONNECTION CHECKS: Check if this user is rejoining an old slot
        if (g.p1DisconnectedName && g.p1DisconnectedName === data.name) {
            clearTimeout(g.p1Timeout);
            g.p1 = socket.id;
            g.p1DisconnectedName = null;
            g.gameActive = !!g.p2; // Reactivate if opponent is here
            socket.emit('joinSuccess', { playerNum: 1, p1Name: g.p1Name, p2Name: g.p2Name });
            io.to(data.gameId).emit('playerReconnected', { msg: `${g.p1Name} reconnected!` });
        } else if (g.p2DisconnectedName && g.p2DisconnectedName === data.name) {
            clearTimeout(g.p2Timeout);
            g.p2 = socket.id;
            g.p2DisconnectedName = null;
            g.gameActive = !!g.p1;
            socket.emit('joinSuccess', { playerNum: 2, p1Name: g.p1Name, p2Name: g.p2Name });
            io.to(data.gameId).emit('playerReconnected', { msg: `${g.p2Name} reconnected!` });
        } else if (!g.p2 && !g.p2DisconnectedName) {
            // Normal Player 2 Join
            g.p2 = socket.id;
            g.p2Name = data.name;
            g.gameActive = true; 
            socket.emit('joinSuccess', { playerNum: 2, p1Name: g.p1Name, p2Name: g.p2Name });
        } else {
            // Spectator Join
            g.spectators.push(socket.id);
            socket.emit('joinSuccess', { playerNum: 0, p1Name: g.p1Name, p2Name: g.p2Name });
        }

        io.to(data.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
        });
        broadcastGameDirectory();
    });

    socket.on('playerActionMove', (data) => {
        const g = games[socket.gameId];
        if (!g || !g.gameActive) return;

        const senderNum = g.p1 === socket.id ? 1 : (g.p2 === socket.id ? 2 : 0);
        if (senderNum !== g.currentPlayer || senderNum === 0) return;

        let targetRow = -1;
        for (let r = 5; r >= 0; r--) {
            if (g.board[r][data.col] === 0) { targetRow = r; break; }
        }
        if (targetRow === -1) return;

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

        g.currentPlayer = g.currentPlayer === 1 ? 2 : 1;
        io.to(socket.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
        });
    });

    // SURRENDER TRIGGER HOOK
    socket.on('requestMatchReset', () => {
        const g = games[socket.gameId];
        if (!g) return;

        const senderNum = g.p1 === socket.id ? 1 : (g.p2 === socket.id ? 2 : 0);
        if (senderNum === 0) return; // Spectators ignored

        // If game is actively running, this counts as folding/forfeiting
        if (g.gameActive) {
            if (senderNum === 1) {
                g.p2Score++;
                io.to(socket.gameId).emit('forfeitMessage', { msg: `🏳️ ${g.p1Name} folded! Match point awarded to ${g.p2Name}.` });
            } else {
                g.p1Score++;
                io.to(socket.gameId).emit('forfeitMessage', { msg: `🏳️ ${g.p2Name} folded! Match point awarded to ${g.p1Name}.` });
            }
        }

        g.board = Array(6).fill(null).map(() => Array(7).fill(0));
        g.currentPlayer = 1;
        g.gameActive = !!(g.p1 && g.p2 && !g.p1DisconnectedName && !g.p2DisconnectedName);

        io.to(socket.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score
        });
        io.to(socket.gameId).emit('gameRestarted');
    });

    socket.on('disconnect', () => {
        const gId = socket.gameId;
        const g = games[gId];
        if (g) {
            if (g.p1 === socket.id) {
                g.p1 = null;
                g.p1DisconnectedName = g.p1Name;
                g.gameActive = false;
                io.to(gId).emit('opponentDisconnected', { msg: `${g.p1Name} disconnected! Waiting 60s for re-entry...` });
                
                // Keep room open for 60 seconds
                g.p1Timeout = setTimeout(() => {
                    if (games[gId] && !games[gId].p1) {
                        io.to(gId).emit('roomDestroyed');
                        delete games[gId];
                        broadcastGameDirectory();
                    }
                }, 60000);

            } else if (g.p2 === socket.id) {
                g.p2 = null;
                g.p2DisconnectedName = g.p2Name;
                g.gameActive = false;
                io.to(gId).emit('opponentDisconnected', { msg: `${g.p2Name} disconnected! Waiting 60s for re-entry...` });
                
                g.p2Timeout = setTimeout(() => {
                    if (games[gId] && !games[gId].p2) {
                        io.to(gId).emit('roomDestroyed');
                        delete games[gId];
                        broadcastGameDirectory();
                    }
                }, 60000);
            } else {
                g.spectators = g.spectators.filter(id => id !== socket.id);
            }
            broadcastGameDirectory();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
