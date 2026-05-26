const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

let games = {}; 

function broadcastGameDirectory() {
    const list = Object.keys(games).map(id => ({
        id: id,
        name: games[id].gameName,
        hasP2: !!games[id].p2 || !!games[id].p2DisconnectedName,
        hasPassword: !!games[id].password,
        specCount: games[id].spectators.length
    }));
    io.emit('gameListUpdate', list);
}

function getWinningCells(board, r, c) {
    const p = board[r][c];
    const directions = [[,[0,-1]], [,[-1,0]], [,[-1,-1]], [[1,-1],[-1,1]]];
    for (const dir of directions) {
        let winningCoordinates = [{ r, c }];
        for (const [dr, dc] of dir) {
            let stepR = r + dr; let stepC = c + dc;
            while (stepR >= 0 && stepR < 6 && stepC >= 0 && stepC < 7 && board[stepR][stepC] === p) {
                winningCoordinates.push({ r: stepR, c: stepC });
                stepR += dr; stepC += dc;
            }
        }
        if (winningCoordinates.length >= 4) return winningCoordinates;
    }
    return null;
}
io.on('connection', (socket) => {
    broadcastGameDirectory();

    socket.on('createGame', (data) => {
        const gameId = `game_${Date.now()}`;
        games[gameId] = {
            gameName: data.gameName,
            password: data.password || null,
            p1: socket.id, p1Name: data.name, p1Score: 0, p1Timeout: null,
            p2: null, p2Name: null, p2Score: 0, p2Timeout: null,
            p1DisconnectedName: null, p2DisconnectedName: null, 
            spectators: [],
            board: Array(6).fill(null).map(() => Array(7).fill(0)),
            currentPlayer: 1, startingPlayer: 1, gamesPlayed: 0, gameActive: false,
            lastPlayedRow: null, lastPlayedCol: null // Coordinate parameters
        };
        socket.gameId = gameId;
        socket.join(gameId);
        socket.emit('joinSuccess', { playerNum: 1, p1Name: data.name });
        broadcastGameDirectory();
    });

    socket.on('joinGame', (data) => {
        const g = games[data.gameId];
        if (!g) { socket.emit('joinFailure', 'Game room no longer exists!'); return; }
        if (g.password && g.password !== data.password) { socket.emit('joinFailure', 'Incorrect password!'); return; }

        socket.gameId = data.gameId; socket.join(data.gameId);

        if (g.p1DisconnectedName && g.p1DisconnectedName === data.name) {
            clearTimeout(g.p1Timeout); g.p1 = socket.id; g.p1DisconnectedName = null; g.gameActive = !!g.p2; 
            socket.emit('joinSuccess', { playerNum: 1, p1Name: g.p1Name, p2Name: g.p2Name });
            io.to(data.gameId).emit('playerReconnected', { msg: `${g.p1Name} reconnected!` });
        } else if (g.p2DisconnectedName && g.p2DisconnectedName === data.name) {
            clearTimeout(g.p2Timeout); g.p2 = socket.id; g.p2DisconnectedName = null; g.gameActive = !!g.p1;
            socket.emit('joinSuccess', { playerNum: 2, p1Name: g.p1Name, p2Name: g.p2Name });
            io.to(data.gameId).emit('playerReconnected', { msg: `${g.p2Name} reconnected!` });
        } else if (!g.p2 && !g.p2DisconnectedName) {
            g.p2 = socket.id; g.p2Name = data.name; g.gameActive = true; 
            socket.emit('joinSuccess', { playerNum: 2, p1Name: g.p1Name, p2Name: g.p2Name });
        } else {
            g.spectators.push(socket.id);
            socket.emit('joinSuccess', { playerNum: 0, p1Name: g.p1Name, p2Name: g.p2Name });
        }

        io.to(data.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score,
            winnerSide: null, winningCells: null, lastPlayedRow: g.lastPlayedRow, lastPlayedCol: g.lastPlayedCol
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
        g.lastPlayedRow = targetRow;
        g.lastPlayedCol = data.col;

        const winningCells = getWinningCells(g.board, targetRow, data.col);
        if (winningCells) {
            const winner = g.currentPlayer; if (winner === 1) g.p1Score++; else g.p2Score++;
            g.gameActive = false; g.gamesPlayed++;
            io.to(socket.gameId).emit('gameStateUpdate', {
                board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
                p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score,
                winnerSide: winner, winningCells: winningCells, lastPlayedRow: g.lastPlayedRow, lastPlayedCol: g.lastPlayedCol
            });
            io.to(socket.gameId).emit('gameFinished', { type: 'win', winner: winner });
            return;
        }

        if (g.board.every(row => row.every(cell => cell !== 0))) {
            g.gameActive = false; g.gamesPlayed++;
            io.to(socket.gameId).emit('gameStateUpdate', {
                board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
                p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score,
                winnerSide: null, winningCells: null, lastPlayedRow: g.lastPlayedRow, lastPlayedCol: g.lastPlayedCol
            });
            io.to(socket.gameId).emit('gameFinished', { type: 'draw' });
            return;
        }

        g.currentPlayer = g.currentPlayer === 1 ? 2 : 1;
        io.to(socket.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score,
            winnerSide: null, winningCells: null, lastPlayedRow: g.lastPlayedRow, lastPlayedCol: g.lastPlayedCol
        });
    });

    socket.on('requestMatchReset', () => {
        const g = games[socket.gameId]; if (!g) return;
        const senderNum = g.p1 === socket.id ? 1 : (g.p2 === socket.id ? 2 : 0); if (senderNum === 0) return;

        if (g.gameActive) {
            g.gamesPlayed++;
            if (senderNum === 1) g.p2Score++; else g.p1Score++;
        }

        g.board = Array(6).fill(null).map(() => Array(7).fill(0));
        g.lastPlayedRow = null; g.lastPlayedCol = null;
        g.startingPlayer = (g.gamesPlayed % 2 === 0) ? 1 : 2; g.currentPlayer = g.startingPlayer;
        g.gameActive = !!(g.p1 && g.p2 && !g.p1DisconnectedName && !g.p2DisconnectedName);

        io.to(socket.gameId).emit('gameStateUpdate', {
            board: g.board, currentPlayer: g.currentPlayer, gameActive: g.gameActive,
            p1Name: g.p1Name, p2Name: g.p2Name, p1Score: g.p1Score, p2Score: g.p2Score,
            winnerSide: null, winningCells: null, lastPlayedRow: g.lastPlayedRow, lastPlayedCol: g.lastPlayedCol
        });
        io.to(socket.gameId).emit('gameRestarted');
    });

    socket.on('disconnect', () => {
        const gId = socket.gameId; const g = games[gId];
        if (g) {
            if (g.p1 === socket.id) {
                g.p1 = null; g.p1DisconnectedName = g.p1Name; g.gameActive = false;
                io.to(gId).emit('opponentDisconnected', { msg: `${g.p1Name} disconnected! Waiting 60s...` });
                g.p1Timeout = setTimeout(() => { if (games[gId] && !games[gId].p1) { io.to(gId).emit('roomDestroyed'); delete games[gId]; broadcastGameDirectory(); } }, 60000);
            } else if (g.p2 === socket.id) {
                g.p2 = null; g.p2DisconnectedName = g.p2Name; g.gameActive = false;
                io.to(gId).emit('opponentDisconnected', { msg: `${g.p2Name} disconnected! Waiting 60s...` });
                g.p2Timeout = setTimeout(() => { if (games[gId] && !games[gId].p2) { io.to(gId).emit('roomDestroyed'); delete games[gId]; broadcastGameDirectory(); } }, 60000);
            } else { g.spectators = g.spectators.filter(id => id !== socket.id); }
            broadcastGameDirectory();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
