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

process.on('SIGTERM', async () => {
    console.log('Received SIGTERM. Cleaning up containers...');
    await cleanupAllSessions();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT. Cleaning up containers...');
    await cleanupAllSessions();
    process.exit(0);
});

async function cleanupAllSessions() {
    const cleanupPromises = Array.from(activeSessions.keys()).map(sessionId => 
        cleanupSession(sessionId)
    );
    
    try {
        await Promise.all(cleanupPromises);
        console.log('All sessions cleaned up successfully');
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
}

app.use(cors());
app.use(express.json());

const BLOCKED_COMMANDS = [
    // System modification/information commands
    'shutdown', 'reboot', 'init', 'poweroff',
    'fdisk', 'mkfs', 'mkswap',
    'mount', 'umount',
    'iptables', 'ip6tables',
    
    // Process/kernel operations
    'kexec', 'kernel', 'modprobe', 'insmod', 'rmmod',
    'sysctl',
    
    // Network security sensitive commands
    'tcpdump', 'wireshark', 'nmap',
    
    // Docker escape attempts
    'docker', 'kubectl',
    
    // Direct hardware access
    'dd', 'rawread', 'rawwrite',
    
    // System files modification
    'chroot',
    
    // Potentially dangerous system info
    'lsmod', 'lspci', 'lsusb',
];

function isCommandBlocked(command) {
    const cmd = command.trim().split(' ')[0].toLowerCase();
    return BLOCKED_COMMANDS.includes(cmd) || 
           BLOCKED_COMMANDS.some(blocked => cmd.startsWith(blocked + ' '));
}

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
                `COLUMNS=${cols}`,
                `LINES=${rows}`
            ],
            Cmd: ["/bin/bash"],
            HostConfig: {
                AutoRemove: true,
                Memory: 512 * 1024 * 1024,
                MemorySwap: 512 * 1024 * 1024,
                CpuShares: 256,
                SecurityOpt: [
                    'no-new-privileges:false',
                    'seccomp=unconfined'
                ],
                CapDrop: ['ALL'],
                CapAdd: [
                    'AUDIT_WRITE',
                    'CHOWN',
                    'DAC_OVERRIDE',
                    'SETGID',
                    'SETUID',
                    'NET_BIND_SERVICE',
                    'SYS_ADMIN'
                ],
                NetworkMode: 'bridge',
                ReadonlyRootfs: false,
                PidsLimit: 100,
                Ulimits: [
                    { Name: 'nofile', Soft: 1024, Hard: 2048 }
                ]
            },
            WorkingDir: '/root'
        });

        await container.start();

        const exec = await container.exec({
            Cmd: ['/bin/bash', '-c', `
                yum update -y && \
                yum install -y sudo && \
                useradd -m -s /bin/bash admin && \
                echo "admin:admin" | chpasswd && \
                usermod -aG wheel admin && \
                echo "admin ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
            `],
            AttachStdout: true,
            AttachStderr: true
        });
        await exec.start();

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

app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    try {
        await cleanupSession(sessionId);
        res.json({ message: 'Session terminated successfully' });
    } catch (error) {
        console.error('Error terminating session:', error);
        res.status(500).json({ error: 'Failed to terminate session' });
    }
});

wss.on('connection', async (ws, req) => {
    const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
    const session = activeSessions.get(sessionId);

    if (!session) {
        ws.send('Session not found or expired\r\n');
        ws.close();
        return;
    }

    try {
        const { container, dimensions } = session;
        let commandBuffer = '';
        
        const exec = await container.exec({
            Cmd: ['/bin/bash'],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: true,
            Env: [
                "TERM=xterm-256color",
                `COLUMNS=${dimensions.cols}`,
                `LINES=${dimensions.rows}`
            ]
        });

        const stream = await exec.start({
            hijack: true,
            stdin: true,
            Tty: true
        });

        session.exec = exec;
        session.stream = stream;

        const initCommands = [
            'export TERM=xterm-256color',
            `export COLUMNS=${dimensions.cols}`,
            `export LINES=${dimensions.rows}`,
            'export PS1="[\\u@\\h \\W]\\$ "',
            `stty rows ${dimensions.rows} cols ${dimensions.cols}`,
            // Add trap for terminal cleanup
            'trap "printf \\"\\033[2J\\033[H\\033[3J\\"; stty sane" EXIT',
            'clear'
        ];

        for (const cmd of initCommands) {
            stream.write(cmd + '\n');
        }

        ws.on('message', (data) => {
            try {
                session.lastActivity = Date.now();
                const input = data.toString();
                
                if (input === '\r' || input === '\n') {
                    if (commandBuffer.trim() && isCommandBlocked(commandBuffer.trim())) {
                        stream.write('\r\nThis command is blocked for security reasons\r\n');
                        commandBuffer = '';
                        return;
                    }
                    
                    // Handle top command exit with SIGINT
                    if (commandBuffer.trim() === 'q' && session.lastCommand === 'top') {
                        stream.write('\x03'); // Send CTRL+C
                        stream.write('\r\n'); // New line
                        session.lastCommand = '';
                        commandBuffer = '';
                        return;
                    }
                    
                    if (commandBuffer.trim()) {
                        session.lastCommand = commandBuffer.trim().split(' ')[0];
                    }
                    
                    commandBuffer = '';
                } else {
                    commandBuffer += input;
                }
                
                stream.write(data);
            } catch (error) {
                console.error('Error processing input:', error);
            }
        });

        stream.on('data', (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                // Break large chunks into smaller pieces
                const maxChunkSize = 1024;
                if (chunk.length > maxChunkSize) {
                  for (let i = 0; i < chunk.length; i += maxChunkSize) {
                    const subChunk = chunk.slice(i, Math.min(i + maxChunkSize, chunk.length));
                    ws.send(Buffer.from(subChunk));
                  }
                } else {
                  ws.send(Buffer.from(chunk));
                }
              } catch (error) {
                console.error('Error sending data to websocket:', error);
              }
            }
          });

        stream.on('error', (error) => {
            console.error('Stream error:', error);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send('\r\nTerminal error occurred. Reconnecting...\r\n');
            }
        });

        session.handleResize = async (cols, rows) => {
            try {
                await exec.resize({ h: rows, w: cols });
                stream.write(`stty rows ${rows} cols ${cols}\n`);
            } catch (error) {
                console.error('Error resizing terminal:', error);
            }
        };

        ws.on('close', () => {
            console.log(`WebSocket closed for session: ${sessionId}`);
            stream.end();
        });

    } catch (error) {
        console.error('Error setting up WebSocket connection:', error);
        ws.close();
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions.entries()) {
        if (now - session.lastActivity > 30 * 60 * 1000) {
            cleanupSession(sessionId);
        }
    }
}, 60 * 1000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

const resetTerminalState = (stream, dimensions) => {
    stream.write('\x1b[2J');
    stream.write('\x1b[H');
    stream.write('\x1b[3J');
    stream.write(`\x1b[8;${dimensions.rows};${dimensions.cols}t`);
    stream.write('\xbc');
};