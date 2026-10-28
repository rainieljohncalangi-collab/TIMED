const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';
const mongoURI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/scancheck?retryWrites=false';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '556271478426-kbs3q9v1cb5p9n9ku1ms9rl2gf962jd7.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

// Helper to get the dynamic base URL from the request
function getDynamicBaseUrl(req) {
    const host = req.get('host'); // e.g. "192.168.100.3:5000" or "localhost:5000"
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    return `${proto}://${host}`;
}
const oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
const hasGoogleOAuthConfig = Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET &&
    GOOGLE_CLIENT_ID !== 'YOUR_GOOGLE_CLIENT_ID' &&
    GOOGLE_CLIENT_SECRET !== 'YOUR_GOOGLE_CLIENT_SECRET' &&
    GOOGLE_CLIENT_SECRET !== 'PASTE_YOUR_CLIENT_SECRET_HERE'
);

if (!hasGoogleOAuthConfig) {
    console.warn('Google OAuth is not fully configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before testing the login flow.');
}

function isValidGmailEmail(email) {
    return typeof email === 'string' && /^[a-zA-Z0-9._%+-]+@gmail\.com$/i.test(email.trim());
}

// ==========================================
// 1. MIDDLEWARES
// ==========================================
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use((req, res, next) => {
    if (/\.html?$/i.test(req.path) || req.path === '/') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});
app.use(express.static(path.join(__dirname)));

// ==========================================
// 2. DATABASE CONNECTION (MongoDB)
// ==========================================
let isMongoConnected = false;

mongoose.connection.on('connected', () => {
    isMongoConnected = true;
});

mongoose.connection.on('disconnected', () => {
    isMongoConnected = false;
});

async function connectToMongo() {
    try {
        await mongoose.connect(mongoURI, {
            family: 4,
            serverSelectionTimeoutMS: 5000
        });

        isMongoConnected = true;
        console.log(`✅ Connected to MongoDB database "${mongoose.connection.name}".`);
    } catch (err) {
        isMongoConnected = false;
        console.error('MongoDB connection error:', err.message);
        console.log('Check that MongoDB Server is running. Retrying in 5 seconds...');
        setTimeout(connectToMongo, 5000);
        return;
    }

    try {
        await seedAdminAccount();
    } catch (err) {
        console.error('Unable to create the administrator account:', err.message);
    }
}

connectToMongo();

// ==========================================
// 3. USER SCHEMA AT MODEL PARA SA MONGODB
// ==========================================
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    role: { type: String, required: true, default: 'teacher' },
    password: { type: String, required: true },
    profilePic: { type: String, required: false }
});

const User = mongoose.model('User', userSchema);

async function seedAdminAccount() {
    const username = (process.env.ADMIN_USERNAME || '').trim();
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || '';
    const hasAdminConfig = username || email || password;

    if (!hasAdminConfig) {
        console.log('Admin account not configured. Set ADMIN_USERNAME, ADMIN_EMAIL, and ADMIN_PASSWORD in .env to create one.');
        return;
    }

    if (!username || !isValidGmailEmail(email) || password.length < 12) {
        console.error('Admin account was not created. Set ADMIN_USERNAME, a valid ADMIN_EMAIL, and an ADMIN_PASSWORD of at least 12 characters in .env.');
        return;
    }

    const existingUser = await User.findOne({
        $or: [
            { username: { $regex: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } },
            { email: { $regex: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } }
        ]
    });

    if (existingUser) {
        if (existingUser.role === 'admin') {
            console.log(`Admin account "${existingUser.username}" already exists in MongoDB.`);
        } else {
            console.error('Admin account was not created because the configured username or email already belongs to a non-admin account.');
        }
        return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    await User.create({ username, email, role: 'admin', password: hashedPassword });
    console.log(`Admin account "${username}" was created in MongoDB.`);
}

// A quiz is the shared source of truth for both the website and Android OMR app.
// answerKey is an array of question entries. Each entry is an object:
//   { t: 'MC'|'TF'|'YN', a: <answer index> }
// where for 'MC' a is 0-4 (A-E), and for 'TF'/'YN' a is 0/1 (False/True, No/Yes).
// Legacy quizzes stored as plain numbers (A=0..E=4) are still accepted and
// normalized to { t: 'MC', a }.
const quizSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true, maxlength: 160 },
    answerKey: { type: [mongoose.Schema.Types.Mixed], required: true },
    totalItems: { type: Number, required: true, min: 1, max: 60 }
}, { timestamps: true });
const Quiz = mongoose.model('Quiz', quizSchema);

// Normalize an answerKey array. Accepts either the legacy plain-number format
// (MC only) or the object format. Returns a normalized object array or null
// if the input is invalid.
function normalizeAnswerKey(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out = [];
    for (const item of arr) {
        if (Number.isInteger(item)) {
            // Legacy MC-only format: A=0, B=1, C=2, D=3, E=4
            if (item < 0 || item > 4) return null;
            out.push({ t: 'MC', a: item });
        } else if (item && typeof item === 'object') {
            const t = String(item.t || 'MC').toUpperCase();
            const a = Number(item.a);
            if (t === 'MC') {
                if (!Number.isInteger(a) || a < 0 || a > 4) return null;
            } else if (t === 'TF') {
                if (a !== 0 && a !== 1) return null;
            } else if (t === 'YN') {
                if (a !== 0 && a !== 1) return null;
            } else {
                return null;
            }
            out.push({ t, a });
        } else {
            return null;
        }
    }
    return out;
}

// Each scanned result is stored as its own document. There is intentionally no
// TTL/expiry index here: score records are retained until an authorized user
// explicitly deletes them.
const scoreSchema = new mongoose.Schema({
    studentName: { type: String, required: true, trim: true, maxlength: 160 },
    studentNumber: { type: String, trim: true, maxlength: 50, default: '' },
    score: { type: Number, required: true, min: 0 },
    totalItems: { type: Number, required: true, min: 1 },
    quizId: { type: String, required: true, trim: true, maxlength: 100 },
    section: { type: String, trim: true, maxlength: 100, default: '' },
    academicYear: { type: String, trim: true, maxlength: 30, default: '' },
    recordFileId: { type: String, trim: true, maxlength: 100, default: '' }
}, { timestamps: true });

// These indexes keep date- and quiz-based history queries efficient as the
// collection grows over many years. They do not limit the number of records.
scoreSchema.index({ createdAt: -1 });
scoreSchema.index({ quizId: 1, createdAt: -1 });
scoreSchema.index({ section: 1, academicYear: 1, createdAt: -1 });
const Score = mongoose.model('Score', scoreSchema);

// A record file is a teacher-created container for the students and scores of
// one section and school year.
const recordFileSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true, maxlength: 160 },
    section: { type: String, required: true, trim: true, maxlength: 100 },
    academicYear: { type: String, required: true, trim: true, maxlength: 30 }
}, { timestamps: true });
recordFileSchema.index({ section: 1, academicYear: 1, createdAt: -1 });
const RecordFile = mongoose.model('RecordFile', recordFileSchema);

function requireMongo(req, res, next) {
    if (!isMongoConnected) {
        return res.status(503).json({
            message: 'Database is unavailable. Please make sure MongoDB is running or MONGODB_URI is set correctly.'
        });
    }

    next();
}

// ==========================================
// 4. FRONT-END ROUTES
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'log.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'register.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'profile.html'));
});

app.get('/forgot', (req, res) => {
    res.sendFile(path.join(__dirname, 'forgorp.html'));
});

app.get('/omr-sheet', (req, res) => {
    res.sendFile(path.join(__dirname, 'testsync-omr-sheet.html'));
});

// Serve the APK download page and APK file for phone installation
app.get('/install', (req, res) => {
    res.sendFile(path.join(__dirname, 'install-apk.html'));
});

app.get('/apk', (req, res) => {
    const apkPath = path.join(__dirname, 'android-scanner', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    if (fs.existsSync(apkPath)) {
        res.download(apkPath, 'TestSync-v1.0.apk');
    } else {
        res.status(404).send('APK file not found. Run ./gradlew assembleDebug first.');
    }
});

app.get('/auth/google', (req, res) => {
    if (!hasGoogleOAuthConfig) {
        return res.status(500).send('Google OAuth is not configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your environment, then restart the server.');
    }

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'select_account',
        scope: ['openid', 'email', 'profile']
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) {
            return res.status(400).send('Missing auth code from Google.');
        }

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const ticket = await oauth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        const email = payload.email.toLowerCase();
        const username = payload.name ? payload.name.replace(/\s+/g, '_').toLowerCase() : email.split('@')[0];
        const profilePic = payload.picture || '';

        if (!isValidGmailEmail(email)) {
            return res.status(400).send('Please use a valid Gmail account.');
        }

        let user = await User.findOne({ email: { $regex: new RegExp(`^${email}$`, 'i') } });
        if (!user) {
            const salt = await bcrypt.genSalt(10);
            const randomPassword = email + Date.now();
            const hashedPassword = await bcrypt.hash(randomPassword, salt);

            user = new User({
                username,
                email,
                role: 'student',
                password: hashedPassword,
                profilePic
            });
            await user.save();
        }

        const frontendBase = process.env.FRONTEND_BASE || getDynamicBaseUrl(req);
        const redirectUrl = `${frontendBase}/google-callback.html?username=${encodeURIComponent(user.username)}&email=${encodeURIComponent(user.email)}&role=${encodeURIComponent(user.role)}&profilePic=${encodeURIComponent(profilePic)}`;
        res.redirect(redirectUrl);
    } catch (err) {
        console.error('Google OAuth callback error:', err);
        res.status(500).send('Google OAuth error. Check server logs.');
    }
});

// ==========================================
// 5. HEALTH CHECK
// ==========================================
app.get('/api/health', (req, res) => {
    res.status(200).json({
        ok: true,
        mongoConnected: isMongoConnected
    });
});

// ==========================================
// 6. API ENDPOINTS
// ==========================================

// Self-hosted QR code generator. The OMR answer sheet embeds a QR code that
// contains the JSON data the Android scanner reads (see parseSheetQr in
// MainActivity.kt). Serving the QR ourselves keeps printing working even
// without internet access to external QR services.
app.get('/api/qr', async (req, res) => {
    try {
        const data = typeof req.query.data === 'string' ? req.query.data.trim() : '';
        if (!data) {
            return res.status(400).json({ message: 'Missing data query parameter.' });
        }
        // The data is meant to be JSON, but we accept any short string so the
        // route stays a generic QR encoder for the answer sheet.
        if (Buffer.byteLength(data, 'utf8') > 4000) {
            return res.status(400).json({ message: 'QR data is too long.' });
        }

        const svg = await QRCode.toString(data, {
            type: 'svg',
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 180,
            color: { dark: '#000000', light: '#ffffff' }
        });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store');
        res.send(svg);
    } catch (err) {
        console.error('QR generation error:', err);
        res.status(500).json({ message: 'Unable to generate QR code.' });
    }
});

// [A] REGISTER ENDPOINT
app.get('/api/quizzes', requireMongo, async (req, res) => {
    try {
        const quizzes = await Quiz.find().sort({ createdAt: -1 }).lean();
        res.setHeader('Cache-Control', 'no-store');
        res.json(quizzes);
} catch (err) {
        console.error('Get quizzes error:', err);
        res.status(500).json({ message: 'Unable to load quizzes.' });
    }
});

app.post('/api/quizzes', requireMongo, async (req, res) => {
    try {
        const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
        const totalItems = Number(req.body.totalItems);
        const answerKey = normalizeAnswerKey(req.body.answerKey);
        if (!title || !Number.isInteger(totalItems) || totalItems < 1 || totalItems > 60 ||
            !answerKey || answerKey.length !== totalItems) {
            return res.status(400).json({ message: 'Invalid quiz title, item count, or answer key.' });
        }
        const quiz = await Quiz.create({ title, totalItems, answerKey });
        res.status(201).json(quiz);
    } catch (err) {
        console.error('Create quiz error:', err);
        res.status(500).json({ message: 'Unable to create quiz.' });
    }
});

app.delete('/api/quizzes/:id', requireMongo, async (req, res) => {
    try {
        const quiz = await Quiz.findByIdAndDelete(req.params.id);
        if (!quiz) return res.status(404).json({ message: 'Quiz not found.' });
        res.json({ message: 'Quiz deleted.' });
    } catch (err) {
        res.status(400).json({ message: 'Invalid quiz ID.' });
    }
});

app.put('/api/quizzes/:id', requireMongo, async (req, res) => {
    try {
const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
        const totalItems = Number(req.body.totalItems);
        const answerKey = normalizeAnswerKey(req.body.answerKey);
        if (!title || !Number.isInteger(totalItems) || totalItems < 1 || totalItems > 60 ||
            !answerKey || answerKey.length !== totalItems) {
            return res.status(400).json({ message: 'Invalid quiz title, item count, or answer key.' });
        }
        const quiz = await Quiz.findByIdAndUpdate(req.params.id, { title, totalItems, answerKey }, { new: true, runValidators: true });
        if (!quiz) return res.status(404).json({ message: 'Quiz not found.' });
        res.json(quiz);
    } catch (err) {
        res.status(400).json({ message: 'Unable to update quiz.' });
    }
});

// Store every OMR scan in MongoDB. No limit or automatic retention period is
// applied, so records remain available for long-term history.
app.post('/api/scores', requireMongo, async (req, res) => {
    try {
        const studentName = typeof req.body.studentName === 'string' ? req.body.studentName.trim() : '';
        const studentNumber = typeof req.body.studentNumber === 'string' ? req.body.studentNumber.trim() : '';
        const score = Number(req.body.score);
        const totalItems = Number(req.body.totalItems);
        const quizId = typeof req.body.quizId === 'string' ? req.body.quizId.trim() : '';
        const section = typeof req.body.section === 'string' ? req.body.section.trim() : '';
        const academicYear = typeof req.body.academicYear === 'string' ? req.body.academicYear.trim() : '';
        const recordFileId = typeof req.body.recordFileId === 'string' ? req.body.recordFileId.trim() : '';

        if (!studentName || !quizId || !Number.isInteger(score) || !Number.isInteger(totalItems) ||
            totalItems < 1 || score < 0 || score > totalItems) {
            return res.status(400).json({ success: false, message: 'Invalid score data.' });
        }

        const savedScore = await Score.create({ studentName, studentNumber, score, totalItems, quizId, section, academicYear, recordFileId });
        res.status(201).json({
            success: true,
            message: 'Score saved permanently.',
            id: savedScore._id
        });
    } catch (err) {
        console.error('Save score error:', err);
        res.status(500).json({ success: false, message: 'Unable to save score.' });
    }
});

app.get('/api/scores', requireMongo, async (req, res) => {
    try {
        const filter = {};
        for (const key of ['section', 'academicYear', 'recordFileId', 'quizId']) {
            if (typeof req.query[key] === 'string' && req.query[key].trim()) filter[key] = req.query[key].trim();
        }
res.setHeader('Cache-Control', 'no-store');
        res.json(await Score.find(filter).sort({ createdAt: -1 }).lean());
    } catch (err) {
        console.error('Get scores error:', err);
        res.status(500).json({ message: 'Unable to load scores.' });
    }
});

// Delete every score belonging to one dashboard folder.
app.delete('/api/scores/folder', requireMongo, async (req, res) => {
    try {
        const section = typeof req.body.section === 'string' ? req.body.section.trim() : '';
        const academicYear = typeof req.body.academicYear === 'string' ? req.body.academicYear.trim() : '';
        const result = await Score.deleteMany({ section, academicYear });
        res.json({ message: 'Folder scores deleted.', deletedCount: result.deletedCount });
    } catch (err) {
        console.error('Delete folder scores error:', err);
        res.status(500).json({ message: 'Unable to delete folder scores.' });
    }
});

app.get('/api/record-files', requireMongo, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.json(await RecordFile.find().sort({ createdAt: -1 }).lean());
    }
    catch (err) { res.status(500).json({ message: 'Unable to load record files.' }); }
});

app.post('/api/record-files', requireMongo, async (req, res) => {
    try {
        const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
        const section = typeof req.body.section === 'string' ? req.body.section.trim() : '';
        const academicYear = typeof req.body.academicYear === 'string' ? req.body.academicYear.trim() : '';
        if (!title || !section || !academicYear) return res.status(400).json({ message: 'File name, section, and school year are required.' });
        res.status(201).json(await RecordFile.create({ title, section, academicYear }));
    } catch (err) { res.status(500).json({ message: 'Unable to create record file.' }); }
});

app.delete('/api/record-files/:id', requireMongo, async (req, res) => {
    try {
        const deleted = await RecordFile.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ message: 'Record file not found.' });
        res.json({ message: 'Record file deleted.' });
    } catch (err) { res.status(400).json({ message: 'Invalid record file ID.' }); }
});

app.post('/api/register', requireMongo, async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const normalizedUsername = username.trim().toLowerCase();
        const normalizedEmail = email.trim().toLowerCase();

        if (!isValidGmailEmail(normalizedEmail)) {
            return res.status(400).json({ message: 'Please use a valid Gmail address ending in @gmail.com.' });
        }

        const existingUser = await User.findOne({
            $or: [
                { username: { $regex: new RegExp(`^${normalizedUsername}$`, 'i') } },
                { email: normalizedEmail }
            ]
        });
        if (existingUser) {
            return res.status(400).json({ message: 'Username or Gmail address is already taken.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({
            username: username.trim(),
            email: normalizedEmail,
            role: 'teacher',
            password: hashedPassword
        });

        await newUser.save();
        res.status(201).json({ message: `Teacher account registered successfully for ${username}!` });

    } catch (err) {
        console.error('Register Error:', err);
        res.status(500).json({ message: 'Server error during registration.' });
    }
});

// [B] LOGIN ENDPOINT
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const loginInput = username.trim();
        const normalizedUsername = loginInput.toLowerCase();

        if (!isMongoConnected) {
            return res.status(503).json({ message: 'Database is unavailable. Please make sure MongoDB is running or MONGODB_URI is set correctly.' });
        }

        if (loginInput.includes('@') && !isValidGmailEmail(loginInput)) {
            return res.status(400).json({ message: 'Please use a valid Gmail address for login.' });
        }

        let user;
        if (loginInput.includes('@')) {
            user = await User.findOne({ email: { $regex: new RegExp(`^${loginInput.trim().toLowerCase()}$`, 'i') } });
        } else {
            user = await User.findOne({ username: { $regex: new RegExp(`^${normalizedUsername}$`, 'i') } });
        }

        if (!user) {
            return res.status(400).json({ message: 'Invalid Teacher Username or Password.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid Teacher Username or Password.' });
        }

        res.status(200).json({
            message: 'Login Successful!',
            role: user.role,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });

    } catch (err) {
        console.error('Login Error:', err);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// [C.1] VERIFY ACCOUNT ENDPOINT
app.post('/api/verify-account', requireMongo, async (req, res) => {
    try {
        const { username, email } = req.body;
        const normalizedUsername = username.trim().toLowerCase();
        const normalizedEmail = email.trim().toLowerCase();

        const user = await User.findOne({
            username: { $regex: new RegExp(`^${normalizedUsername}$`, 'i') },
            email: { $regex: new RegExp(`^${normalizedEmail}$`, 'i') }
        });

        if (!user) {
            return res.status(404).json({ message: 'No matching teacher account found.' });
        }

        res.status(200).json({ message: 'Account verified. Proceed to change password.' });

    } catch (err) {
        console.error('Verification Error:', err);
        res.status(500).json({ message: 'Server error during verification.' });
    }
});

// [C.2] RESET PASSWORD ENDPOINT
app.post('/api/reset-password', requireMongo, async (req, res) => {
    try {
        const { username, newPassword } = req.body;
        const normalizedUsername = username.trim().toLowerCase();

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        const updatedUser = await User.findOneAndUpdate(
            { username: { $regex: new RegExp(`^${normalizedUsername}$`, 'i') } },
            { password: hashedPassword },
            { new: true }
        );

        if (!updatedUser) {
            return res.status(400).json({ message: 'Failed to update password. User not found.' });
        }

        res.status(200).json({ message: 'Password updated successfully!' });

    } catch (err) {
        console.error('Reset Password Error:', err);
        res.status(500).json({ message: 'Server error while resetting password.' });
    }
});

// [D] GOOGLE-LIKE GMAIL LOGIN ENDPOINT
app.post('/api/google-login', requireMongo, async (req, res) => {
    try {
        const { email } = req.body;
        const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

        if (!isValidGmailEmail(normalizedEmail)) {
            return res.status(400).json({ message: 'Please use a valid Gmail address ending in @gmail.com.' });
        }

        let user = await User.findOne({ email: { $regex: new RegExp(`^${normalizedEmail}$`, 'i') } });

        if (!user) {
            const username = normalizedEmail.split('@')[0];
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(normalizedEmail, salt);

            user = new User({
                username,
                email: normalizedEmail,
                role: 'student',
                password: hashedPassword
            });

            await user.save();
        }

        res.status(200).json({
            message: 'Google-like login successful.',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });
    } catch (err) {
        console.error('Google Login Error:', err);
        res.status(500).json({ message: 'Server error during Google login.' });
    }
});

app.get('/google-callback.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'google-callback.html'));
});

// ==========================================
// 7. SIMULAN ANG SERVER
// ==================================
if (require.main === module) {
    app.listen(PORT, HOST, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}

module.exports = app;
