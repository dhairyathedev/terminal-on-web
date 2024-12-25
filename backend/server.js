const express = require('express');
const Docker = require('dockerode');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

// Initialize Express and WebSocket server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize Docker
const docker = new Docker();

// Store active sessions
const activeSessions = new Map();

// Middleware
// use the cors to allow the frontend to access the backend
// frontend and backend are running on different ports
// frontend: http://localhost:3000
// backend: http://localhost:3001
app.use(cors());
app.use(express.json());

// Utility function to clean up session
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

// Create a new terminal session
app.post('/api/sessions', async (req, res) => {
    try {
        const sessionId = uuidv4();
        
        // Create container with security constraints
        const container = await docker.createContainer({
            Image: 'persistent_centos', // Using our custom image
            Cmd: ['/bin/bash'],
            Tty: true,
            OpenStdin: true,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Env: [
                "TERM=xterm-256color",
                "SHELL=/bin/bash",
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            ],
            // Security configurations
            HostConfig: {
                AutoRemove: true,
                Memory: 1024 * 1024 * 1024, // 1GB memory limit (increased for development tools)
                MemorySwap: 1024 * 1024 * 1024,
                CpuShares: 512,
                SecurityOpt: ['no-new-privileges'],
                CapDrop: ['ALL'],
                CapAdd: ['NET_ADMIN'], // Added for network tools
                NetworkMode: 'bridge',
                ReadonlyRootfs: false,
                PidsLimit: 100,
            },
            WorkingDir: '/root' // Set working directory
        });

        await container.start();

        // Create exec instance for running commands
        const exec = await container.exec({
            Cmd: ['/bin/bash'],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: [
                "TERM=xterm-256color",
                "SHELL=/bin/bash"
            ]
        });

        const stream = await exec.start({
            hijack: true,
            stdin: true
        });

        // Store session information
        activeSessions.set(sessionId, {
            container,
            exec,
            stream,
            lastActivity: Date.now()
        });

        // Set session timeout
        setTimeout(async () => {
            if (activeSessions.has(sessionId)) {
                await cleanupSession(sessionId);
            }
        }, 30 * 60 * 1000); // 30 minutes timeout

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

// WebSocket connection handler
wss.on('connection', async (ws, req) => {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const session = activeSessions.get(sessionId);

    if (!session) {
        ws.send('Session not found or expired\n');
        ws.close();
        return;
    }

    console.log(`New WebSocket connection for session: ${sessionId}`);

    try {
        const { stream } = session;

        // Send initial connection message
        ws.send('Connected to CentOS Development Terminal. Type your commands...\n');

        // Initial setup commands
        stream.write('export TERM=xterm-256color\n');
        stream.write('export PS1="\\u@\\h:\\w\\$ "\n');
        stream.write('clear\n');

        // Handle incoming data from client
        ws.on('message', async (data) => {
            try {
                session.lastActivity = Date.now();
                const command = data.toString();
                
                if (command.trim().length > 0) {
                    stream.write(command + '\n');
                }
            } catch (error) {
                console.error('Error processing command:', error);
                ws.send('Error processing command\n');
            }
        });

        // Handle data from container
        stream.on('data', (chunk) => {
            try {
                ws.send(chunk.toString());
            } catch (error) {
                console.error('Error sending data to websocket:', error);
            }
        });

        // Handle stream errors
        stream.on('error', (error) => {
            console.error('Stream error:', error);
            ws.send('Terminal error occurred\n');
            ws.close();
        });

        // Handle WebSocket close
        ws.on('close', () => {
            console.log(`WebSocket closed for session: ${sessionId}`);
        });

    } catch (error) {
        console.error('Error setting up WebSocket connection:', error);
        ws.send('Error setting up terminal connection\n');
        ws.close();
    }
});

// Get session status
app.get('/api/sessions/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        sessionId,
        active: true,
        lastActivity: session.lastActivity
    });
});

// Terminate a session
app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    
    if (!activeSessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
    }

    try {
        await cleanupSession(sessionId);
        res.json({ message: 'Session terminated successfully' });
    } catch (error) {
        console.error('Error terminating session:', error);
        res.status(500).json({ error: 'Failed to terminate session' });
    }
});

// Session cleanup interval
setInterval(() => {
    const timeout = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();

    activeSessions.forEach(async (session, sessionId) => {
        if (now - session.lastActivity > timeout) {
            console.log(`Cleaning up inactive session: ${sessionId}`);
            await cleanupSession(sessionId);
        }
    });
}, 5 * 60 * 1000); // Run every 5 minutes

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received. Cleaning up...');
    
    // Clean up all active sessions
    for (const [sessionId, session] of activeSessions) {
        await cleanupSession(sessionId);
    }
    
    server.close(() => {
        console.log('Server shut down complete');
        process.exit(0);
    });
});
