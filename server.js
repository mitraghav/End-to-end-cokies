const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const cors = require('cors');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Session configuration
const sessionMiddleware = session({
    secret: 'facebook-messenger-sender-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    },
    genid: function (req) {
        return uuidv4(); // Generate unique session ID
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(sessionMiddleware);

// Share session with Socket.IO
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/plain') {
            cb(null, true);
        } else {
            cb(new Error('Only .txt files allowed!'), false);
        }
    }
});

// Session-based task management
let sessionTasks = {}; // Format: { sessionId: { taskId: task, ... } }
let sessionBrowsers = {}; // Format: { sessionId: { taskId: browser, ... } }

// Initialize session tasks if not exists
function initSessionTasks(sessionId) {
    if (!sessionTasks[sessionId]) {
        sessionTasks[sessionId] = {};
    }
    if (!sessionBrowsers[sessionId]) {
        sessionBrowsers[sessionId] = {};
    }
}

// Task management class
class MessageSender {
    constructor(taskId, config, sessionId) {
        this.taskId = taskId;
        this.config = config;
        this.sessionId = sessionId;
        this.browser = null;
        this.page = null;
        this.isRunning = false;
        this.currentIndex = 0;
        this.totalSent = 0;
        this.messages = [];
        this.startTime = new Date();
        this.stopTime = null;
    }

    async init() {
        try {
            // Read and process messages file
            const fileContent = await fs.readFile(this.config.filePath, 'utf8');
            this.messages = fileContent.split('\n')
                .map(msg => msg.trim())
                .filter(msg => msg.length > 0);

            if (this.messages.length === 0) {
                throw new Error('No valid messages found in file');
            }

            // Delete the uploaded file after reading
            await fs.remove(this.config.filePath);

            // Launch browser
            this.browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-gpu'
                ]
            });

            this.page = await this.browser.newPage();

            // Set viewport
            await this.page.setViewport({ width: 1366, height: 768 });

            // Set user agent
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

            return true;
        } catch (error) {
            console.error('Initialization error:', error);
            this.emitStatus('error', `Initialization failed: ${error.message}`);
            return false;
        }
    }

    async start() {
        if (!await this.init()) {
            return false;
        }

        this.isRunning = true;
        this.emitStatus('starting', 'Initializing browser and navigating to Facebook...');

        try {
            // Navigate to Facebook and set cookies
            await this.page.goto('https://www.facebook.com', {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            // Set the Facebook cookie
            const cookies = this.parseCookies(this.config.cookie);
            for (const cookie of cookies) {
                await this.page.setCookie(cookie);
            }

            // Navigate to the conversation
            const conversationUrl = `https://www.facebook.com/messages/t/${this.config.threadId}`;
            await this.page.goto(conversationUrl, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            this.emitStatus('active', 'Connected to Facebook. Starting message sending...');

            // Start sending messages
            await this.sendMessages();

        } catch (error) {
            console.error('Start error:', error);
            this.emitStatus('error', `Failed to start: ${error.message}`);
            this.isRunning = false;
            await this.cleanup();
        }
    }

    async sendMessages() {
        while (this.isRunning) {
            try {
                const originalMessage = this.messages[this.currentIndex];
                const finalMessage = this.config.hattersName
                    ? `${this.config.hattersName} ${originalMessage}`
                    : originalMessage;

                // Find and focus on message input
                await this.page.waitForSelector('[role="textbox"], [contenteditable="true"]', {
                    timeout: 10000
                });

                const textbox = await this.page.$('[role="textbox"]') ||
                    await this.page.$('[contenteditable="true"]');

                if (!textbox) {
                    throw new Error('Message textbox not found');
                }

                // Clear and type message
                await textbox.click();
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyA');
                await this.page.keyboard.up('Control');
                await this.page.keyboard.type(finalMessage);

                // Send message
                await this.page.keyboard.press('Enter');

                this.totalSent++;
                this.currentIndex = (this.currentIndex + 1) % this.messages.length;

                this.emitStatus('active',
                    `Message ${this.totalSent} sent. Current: "${originalMessage.substring(0, 50)}${originalMessage.length > 50 ? '...' : ''}"`
                );

                // Wait for specified delay
                await this.delay(this.config.delay * 1000);

            } catch (error) {
                console.error('Message sending error:', error);
                this.emitStatus('error', `Error sending message: ${error.message}`);

                // Try to continue after error
                await this.delay(5000);

                // If too many consecutive errors, stop
                if (error.message.includes('textbox not found')) {
                    this.emitStatus('error', 'Cannot find message input. Stopping task.');
                    break;
                }
            }
        }

        await this.cleanup();
    }

    parseCookies(cookieString) {
        const cookies = [];
        const cookiePairs = cookieString.split(';');

        for (let pair of cookiePairs) {
            const [name, value] = pair.trim().split('=');
            if (name && value) {
                cookies.push({
                    name: name.trim(),
                    value: value.trim(),
                    domain: '.facebook.com',
                    path: '/',
                    httpOnly: false,
                    secure: true
                });
            }
        }

        return cookies;
    }

    async stop() {
        this.isRunning = false;
        this.stopTime = new Date();
        this.emitStatus('stopping', 'Stopping task...');
        await this.cleanup();
        this.emitStatus('stopped', `Task stopped. Total messages sent: ${this.totalSent}`);
    }

    async cleanup() {
        try {
            if (this.page) {
                await this.page.close();
            }
            if (this.browser) {
                await this.browser.close();
            }
        } catch (error) {
            console.error('Cleanup error:', error);
        }

        // Remove from session-specific storage
        if (sessionTasks[this.sessionId]) {
            delete sessionTasks[this.sessionId][this.taskId];
        }
        if (sessionBrowsers[this.sessionId]) {
            delete sessionBrowsers[this.sessionId][this.taskId];
        }
    }

    emitStatus(status, message) {
        const data = {
            taskId: this.taskId,
            status: status,
            message: message,
            totalSent: this.totalSent,
            currentIndex: this.currentIndex,
            totalMessages: this.messages.length,
            threadId: this.config.threadId,
            delay: this.config.delay,
            sessionId: this.sessionId,
            startTime: this.startTime.toISOString(),
            stopTime: this.stopTime ? this.stopTime.toISOString() : null
        };

        // Emit only to the specific session room
        io.to(this.sessionId).emit('taskUpdate', data);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Routes
app.get('/', (req, res) => {
    // Initialize session tasks
    initSessionTasks(req.session.id);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/start-task', upload.single('messageFile'), async (req, res) => {
    try {
        const sessionId = req.session.id;
        initSessionTasks(sessionId);

        const { cookie, threadId, hattersName, delay } = req.body;

        if (!cookie || !threadId || !req.file || !delay) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Check if task already exists in this session
        if (sessionTasks[sessionId][threadId]) {
            return res.status(400).json({
                success: false,
                message: 'Task already running for this thread in your session'
            });
        }

        const taskId = threadId;
        const config = {
            cookie,
            threadId,
            hattersName: hattersName || '',
            delay: parseInt(delay),
            filePath: req.file.path
        };

        const sender = new MessageSender(taskId, config, sessionId);
        sessionTasks[sessionId][taskId] = sender;

        // Start the task in background
        sender.start().catch(error => {
            console.error('Task start error:', error);
            sender.emitStatus('error', `Task failed to start: ${error.message}`);
        });

        res.json({
            success: true,
            message: 'Task started successfully',
            taskId: taskId,
            sessionId: sessionId
        });

    } catch (error) {
        console.error('Start task error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

app.post('/stop-task', (req, res) => {
    const { taskId } = req.body;
    const sessionId = req.session.id;

    if (!taskId || !sessionTasks[sessionId] || !sessionTasks[sessionId][taskId]) {
        return res.status(400).json({
            success: false,
            message: 'Task not found in your session'
        });
    }

    sessionTasks[sessionId][taskId].stop();

    res.json({
        success: true,
        message: 'Task stopped successfully'
    });
});

app.get('/active-tasks', (req, res) => {
    const sessionId = req.session.id;
    initSessionTasks(sessionId);

    const tasks = Object.keys(sessionTasks[sessionId]).map(taskId => ({
        taskId,
        isRunning: sessionTasks[sessionId][taskId].isRunning,
        totalSent: sessionTasks[sessionId][taskId].totalSent,
        currentIndex: sessionTasks[sessionId][taskId].currentIndex,
        totalMessages: sessionTasks[sessionId][taskId].messages.length,
        sessionId: sessionId
    }));

    res.json({ success: true, tasks, sessionId });
});

app.get('/session-info', (req, res) => {
    res.json({
        sessionId: req.session.id,
        activeTasks: Object.keys(sessionTasks[req.session.id] || {}).length
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    const sessionId = socket.request.session.id;

    // Join session-specific room
    socket.join(sessionId);

    console.log(`Client connected: ${socket.id} (Session: ${sessionId})`);

    // Send session info to client
    socket.emit('sessionInfo', { sessionId });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id} (Session: ${sessionId})`);
    });

    // Handle session-specific events
    socket.on('getSessionTasks', () => {
        if (sessionTasks[sessionId]) {
            Object.values(sessionTasks[sessionId]).forEach(task => {
                if (task.isRunning) {
                    task.emitStatus(task.isRunning ? 'active' : 'stopped',
                        `Task running - ${task.totalSent} messages sent`);
                }
            });
        }
    });
});

// Clean up inactive sessions periodically
setInterval(() => {
    Object.keys(sessionTasks).forEach(sessionId => {
        if (sessionTasks[sessionId]) {
            const tasksInSession = Object.keys(sessionTasks[sessionId]).length;
            if (tasksInSession === 0) {
                // Clean up empty session data after 1 hour
                setTimeout(() => {
                    delete sessionTasks[sessionId];
                    delete sessionBrowsers[sessionId];
                }, 60 * 60 * 1000);
            }
        }
    });
}, 5 * 60 * 1000); // Check every 5 minutes

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');

    // Stop all active tasks in all sessions
    for (const sessionId in sessionTasks) {
        for (const taskId in sessionTasks[sessionId]) {
            await sessionTasks[sessionId][taskId].stop();
        }
    }

    process.exit(0);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Facebook Messenger Sender running on port ${PORT}`);
    console.log(`🔒 Session-based task isolation enabled`);
});