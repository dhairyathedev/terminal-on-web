const express = require('express');
const Docker = require('dockerode');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const docker = new Docker();
const activeSessions = new Map();

app.use(cors());
app.use(express.json());

async function cleanupSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
        try {
            await session.container.stop();
            await session.container.remove();
        } catch (error) {
            console.error(`Error cleaning up session ${sessionId}:`, error);
        } finally {
            activeSessions.delete(sessionId);
        }
    }
}

app.post('/api/sessions', async (req, res) => {
    try {
        const sessionId = uuidv4();
        
        // Get terminal dimensions from request
        const { cols = 80, rows = 24 } = req.body;
        
        const container = await docker.createContainer({
            Image: 'persistent_centos',
            Tty: true,
            OpenStdin: true,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Env: [
                "TERM=xterm-256color",
                "SHELL=/bin/bash",
                `COLUMNS=${cols}`,
                `LINES=${rows}`
            ],
            HostConfig: {
                AutoRemove: true,
                Memory: 1024 * 1024 * 1024,
                MemorySwap: 1024 * 1024 * 1024,
                CpuShares: 512,
                SecurityOpt: ['no-new-privileges'],
                CapDrop: ['ALL'],
                CapAdd: ['NET_ADMIN'],
                NetworkMode: 'bridge',
                ReadonlyRootfs: false,
                PidsLimit: 100,
            },
            WorkingDir: '/root'
        });

        await container.start();

        // Store container reference
        activeSessions.set(sessionId, {
            container,
            lastActivity: Date.now(),
            dimensions: { cols, rows }
        });

        res.json({ 
            sessionId,
            message: 'Session created successfully',
            expiresIn: '30 minutes'
        });

    } catch (error) {
        console.error('Error creating session:', error);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// Handle terminal resize
app.post('/api/sessions/:sessionId/resize', async (req, res) => {
    const { sessionId } = req.params;
    const { cols, rows } = req.body;
    const session = activeSessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        const { exec } = session;
        if (exec) {
            await exec.resize({ h: rows, w: cols });
            session.dimensions = { cols, rows };
        }
        res.json({ message: 'Terminal resized' });
    } catch (error) {
        console.error('Error resizing terminal:', error);
        res.status(500).json({ error: 'Failed to resize terminal' });
    }
});

wss.on('connection', async (ws, req) => {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const session = activeSessions.get(sessionId);

    if (!session) {
        ws.send('Session not found or expired\n');
        ws.close();
        return;
    }

    try {
        const { container, dimensions } = session;

        // Create exec instance with proper dimensions
        const exec = await container.exec({
            Cmd: ['/bin/bash'],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: [
                "TERM=xterm-256color",
                "SHELL=/bin/bash",
                `COLUMNS=${dimensions.cols}`,
                `LINES=${dimensions.rows}`
            ]
        });

        const stream = await exec.start({
            hijack: true,
            stdin: true
        });

        // Store exec instance for resize operations
        session.exec = exec;
        session.stream = stream;

        // Setup initial terminal environment
        stream.write('export TERM=xterm-256color\n');
        stream.write(`export COLUMNS=${dimensions.cols}\n`);
        stream.write(`export LINES=${dimensions.rows}\n`);
        stream.write('export PS1="\\u@\\h:\\w\\$ "\n');
        stream.write('clear\n');

        // Handle binary data from client
        ws.on('message', (data) => {
            try {
                session.lastActivity = Date.now();
                stream.write(data);
            } catch (error) {
                console.error('Error processing input:', error);
            }
        });

        // Handle data from container
        stream.on('data', (chunk) => {
            try {
                ws.send(chunk);
            } catch (error) {
                console.error('Error sending data to websocket:', error);
            }
        });

        // Handle stream errors
        stream.on('error', (error) => {
            console.error('Stream error:', error);
            ws.close();
        });

        // Clean up on WebSocket close
        ws.on('close', () => {
            console.log(`WebSocket closed for session: ${sessionId}`);
        });

    } catch (error) {
        console.error('Error setting up WebSocket connection:', error);
        ws.close();
    }
});

// Rest of the code remains the same...

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
