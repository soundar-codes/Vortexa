const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ─── Firebase Initialization ──────────────────────────────────────────────────
let db = null;
try {
    let credential;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        // Option A: paste the entire service account JSON as one env var
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        credential = admin.credential.cert(sa);
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        // Option B: individual env vars (easier for Railway)
        credential = admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        });
    } else {
        throw new Error(
            'Firebase credentials missing. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.'
        );
    }
    admin.initializeApp({ credential });
    db = admin.firestore();
    console.log('[Firebase] Connected to Firestore successfully.');
} catch (err) {
    console.error('[Firebase] Initialization failed:', err.message);
}

// Middleware: reject requests when DB is not ready
function requireDB(req, res, next) {
    if (!db) return res.status(503).json({ error: 'Database not configured. Set Firebase env vars in Railway.' });
    next();
}

// ─── File Upload Setup ────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, 'uploads');
try {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
} catch (e) {
    console.warn('Could not create uploads directory:', e.message);
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname),
});
const upload = multer({ storage });

// ─── Express Setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: ['https://medguardian-92fde.web.app', 'http://localhost:3000', '*'],
  credentials: true
}));
app.use(express.json());
app.use(express.static(__dirname));

// Debug logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check endpoint (no Firebase required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running', timestamp: new Date().toISOString() });
});

// Test environment variables endpoint
app.get('/test-env', (req, res) => {
  res.json({
    hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
    hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
    hasPrivateKey: !!process.env.FIREBASE_PRIVATE_KEY,
    hasJwtSecret: !!process.env.JWT_SECRET,
    projectId: process.env.FIREBASE_PROJECT_ID ? '***' + process.env.FIREBASE_PROJECT_ID.slice(-4) : 'missing'
  });
});

// Simple test endpoint without Firebase
app.post('/api/test', (req, res) => {
  res.json({ message: 'API endpoint working', body: req.body });
});

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_medguardian_key';

// ─── JWT Middleware ───────────────────────────────────────────────────────────
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Invalid token' });
        req.user = decoded;
        next();
    });
};

// ─── SMS Helper ───────────────────────────────────────────────────────────────
async function sendSMS(phone, message) {
    if (process.env.FAST2SMS_API_KEY) {
        try {
            const cleanedPhone = phone.replace(/\D/g, '').slice(-10);
            const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
                method: 'POST',
                headers: { 'authorization': process.env.FAST2SMS_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ route: 'q', message, language: 'english', flash: 0, numbers: cleanedPhone }),
            });
            const data = await response.json();
            if (response.ok && data.return === true) {
                console.log(`[Fast2SMS] SMS sent to ${phone}`);
                return { success: true, provider: 'fast2sms' };
            }
        } catch (err) {
            console.error('[Fast2SMS] Error:', err.message);
        }
    }
    console.log(`[SIMULATED SMS to ${phone}]: ${message}`);
    return { success: false, provider: 'simulation' };
}

// ─── Audit Log Helper ─────────────────────────────────────────────────────────
async function logAudit(userId, action, ip, deviceInfo) {
    if (!db) return;
    try {
        await db.collection('audit_logs').add({
            user_id: userId || null,
            action,
            ip_address: ip || '',
            device_info: deviceInfo || '',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) {
        console.error('Audit log failed:', e.message);
    }
}

// ─── Helper: convert Firestore timestamps in a doc ───────────────────────────
function serializeDoc(id, data) {
    const obj = { id, ...data };
    for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key].toDate === 'function') {
            obj[key] = obj[key].toDate().toISOString();
        }
    }
    return obj;
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ─── PUBLIC: Emergency info ───────────────────────────────────────────────────
app.get('/api/emergency/:userid', requireDB, async (req, res) => {
    try {
        const { userid } = req.params;
        const snap = await db.collection('users')
            .where('userid', '==', userid)
            .where('role', '==', 'patient')
            .limit(1).get();
        if (snap.empty) return res.status(404).json({ error: 'Patient profile not found' });
        const patient = serializeDoc(snap.docs[0].id, snap.docs[0].data());

        const recordsSnap = await db.collection('health_records')
            .where('patient_id', '==', patient.id)
            .where('record_type', 'in', ['allergy', 'prescription'])
            .get();
        const records = recordsSnap.docs.map(d => d.data());

        res.json({
            name: patient.name,
            phone: patient.phone,
            email: patient.email,
            hospital: patient.hospital,
            allergies: records.filter(r => r.record_type === 'allergy')
                .map(r => ({ title: r.title, description: r.description })),
            prescriptions: records.filter(r => r.record_type === 'prescription')
                .map(r => ({ title: r.title, description: r.description })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── CRYPTO AUTH: Device Registration ────────────────────────────────────────
app.post('/api/auth/crypto/:role/register', requireDB, async (req, res) => {
    try {
        const { role } = req.params;
        const { email, publicKey, deviceName } = req.body;
        if (!email || !publicKey) return res.status(400).json({ error: 'Missing required fields' });
        if (role !== 'doctor' && role !== 'admin') return res.status(400).json({ error: 'Invalid role' });

        const userSnap = await db.collection('users')
            .where('email', '==', email).where('role', '==', role).limit(1).get();
        if (userSnap.empty) return res.status(404).json({ error: 'Account not found. Please contact an administrator.' });
        const userId = userSnap.docs[0].id;

        const existingKeys = await db.collection('user_crypto_credentials')
            .where('user_id', '==', userId).where('is_active', '==', true).limit(1).get();
        if (!existingKeys.empty) return res.status(403).json({ error: 'A device is already registered for this account.' });

        await db.collection('user_crypto_credentials').add({
            user_id: userId, role,
            public_key: publicKey,
            key_algorithm: 'ECDSA',
            device_name: deviceName || 'Unknown Browser',
            is_active: true,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            last_used_at: null,
        });
        await logAudit(userId, 'Device Registration', req.ip, req.headers['user-agent']);
        res.status(201).json({ message: 'Device securely registered.', id: userId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── CRYPTO AUTH: Request Challenge ──────────────────────────────────────────
app.post('/api/auth/crypto/:role/challenge', requireDB, async (req, res) => {
    try {
        const { role } = req.params;
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });
        if (role !== 'doctor' && role !== 'admin') return res.status(400).json({ error: 'Invalid role' });

        const userSnap = await db.collection('users')
            .where('email', '==', email).where('role', '==', role).limit(1).get();
        if (userSnap.empty) return res.status(404).json({ error: 'Account not found. Please contact an administrator.' });
        const userId = userSnap.docs[0].id;

        const credsSnap = await db.collection('user_crypto_credentials')
            .where('user_id', '==', userId).where('is_active', '==', true).limit(1).get();
        if (credsSnap.empty) {
            return res.status(403).json({ error: 'Device not registered. Setting up secure key...', requiresSetup: true });
        }

        const nonce = crypto.randomBytes(32).toString('base64');
        const expiresAt = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 60 * 1000));
        await db.collection('auth_challenges').add({
            user_id: userId,
            challenge_nonce: nonce,
            expires_at: expiresAt,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.json({ challenge: nonce });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── CRYPTO AUTH: Verify Signature ───────────────────────────────────────────
app.post('/api/auth/crypto/:role/verify', requireDB, async (req, res) => {
    try {
        const { role } = req.params;
        const { email, signature, clientDataJSON } = req.body;
        if (!email || !signature || !clientDataJSON) return res.status(400).json({ error: 'Missing required fields' });
        if (role !== 'doctor' && role !== 'admin') return res.status(400).json({ error: 'Invalid role' });

        let clientData;
        try { clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64').toString('utf8')); }
        catch (e) { return res.status(400).json({ error: 'Invalid clientDataJSON' }); }
        const returnedChallenge = clientData.challenge;

        const userSnap = await db.collection('users')
            .where('email', '==', email).where('role', '==', role).limit(1).get();
        if (userSnap.empty) return res.status(404).json({ error: 'User not found' });
        const user = serializeDoc(userSnap.docs[0].id, userSnap.docs[0].data());

        // Validate challenge (find + check expiry)
        const challengeSnap = await db.collection('auth_challenges')
            .where('user_id', '==', user.id)
            .where('challenge_nonce', '==', returnedChallenge)
            .limit(1).get();
        if (challengeSnap.empty || challengeSnap.docs[0].data().expires_at.toDate() < new Date()) {
            await logAudit(user.id, 'Login Failure - Expired/Invalid Challenge', req.ip, req.headers['user-agent']);
            return res.status(401).json({ error: 'Invalid or expired challenge' });
        }
        // Delete challenge (one-time use)
        await db.collection('auth_challenges').doc(challengeSnap.docs[0].id).delete();

        // Get public key
        const credsSnap = await db.collection('user_crypto_credentials')
            .where('user_id', '==', user.id).where('is_active', '==', true).limit(1).get();
        if (credsSnap.empty) {
            await logAudit(user.id, 'Login Failure - No Active Device', req.ip, req.headers['user-agent']);
            return res.status(401).json({ error: 'No registered cryptographic identity found on this device.' });
        }
        const publicKeyPem = credsSnap.docs[0].data().public_key;

        // Verify ECDSA signature
        const isValid = crypto.verify(
            'SHA256',
            Buffer.from(clientDataJSON, 'base64'),
            { key: publicKeyPem, dsaEncoding: 'ieee-p1363' },
            Buffer.from(signature, 'base64')
        );
        if (!isValid) {
            await logAudit(user.id, 'Login Failure - Invalid Signature', req.ip, req.headers['user-agent']);
            return res.status(401).json({ error: 'Invalid cryptographic signature' });
        }

        await db.collection('user_crypto_credentials').doc(credsSnap.docs[0].id)
            .update({ last_used_at: admin.firestore.FieldValue.serverTimestamp() });
        await logAudit(user.id, 'Login Success', req.ip, req.headers['user-agent']);

        const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
        res.json({
            message: 'Cryptographic authentication successful.',
            token,
            user: { id: user.id, name: user.name, role: user.role, email: user.email },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Patient Login ────────────────────────────────────────────────────────────
app.post('/api/auth/login', requireDB, async (req, res) => {
    try {
        const { userid } = req.body;
        if (!userid) return res.status(400).json({ error: 'UserID required' });
        const snap = await db.collection('users')
            .where('userid', '==', userid).where('role', '==', 'patient').limit(1).get();
        if (snap.empty) return res.status(401).json({ error: 'Invalid UserID' });
        const user = serializeDoc(snap.docs[0].id, snap.docs[0].data());
        const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, user: { id: user.id, name: user.name, role: user.role, email: user.email, userid: user.userid } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DOCTOR: Get all patients ─────────────────────────────────────────────────
app.get('/api/users/patients', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const [patientsSnap, accessSnap] = await Promise.all([
            db.collection('users').where('role', '==', 'patient').get(),
            db.collection('access_requests').where('doctor_id', '==', req.user.id).get(),
        ]);
        const accessMap = {};
        accessSnap.docs.forEach(d => { accessMap[d.data().patient_id] = d.data().status; });
        const patients = patientsSnap.docs.map(d => ({
            ...serializeDoc(d.id, d.data()),
            status: accessMap[d.id] || null,
        }));
        patients.sort((a, b) => (a.hospital || 'zzz').localeCompare(b.hospital || 'zzz') || a.name.localeCompare(b.name));
        res.json(patients);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DOCTOR: Request access to patient ───────────────────────────────────────
app.post('/api/access/request', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const { patient_id } = req.body;
        // Use composite ID to enforce uniqueness (doctor_patient pair)
        const docId = `${req.user.id}_${patient_id}`;
        await db.collection('access_requests').doc(docId).set({
            doctor_id: req.user.id,
            patient_id,
            status: 'pending',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(201).json({ message: 'Request sent successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── DOCTOR: Create patient ───────────────────────────────────────────────────
app.post('/api/doctor/create-patient', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const { name, email, phone, userid, hospital, prescriptionTitle, prescriptionDesc, healthIssueTitle, healthIssueDesc } = req.body;
        if (!name || !email || !phone || !userid) return res.status(400).json({ error: 'Name, email, phone, and UserID are required' });

        // Uniqueness checks
        const [emailCheck, useridCheck] = await Promise.all([
            db.collection('users').where('email', '==', email).limit(1).get(),
            db.collection('users').where('userid', '==', userid).limit(1).get(),
        ]);
        if (!emailCheck.empty) return res.status(400).json({ error: 'Email already exists' });
        if (!useridCheck.empty) return res.status(400).json({ error: 'UserID already exists' });

        // Batch write: create patient + access + optional records
        const batch = db.batch();
        const patientRef = db.collection('users').doc();
        batch.set(patientRef, {
            name, email, role: 'patient',
            hospital: hospital || null, phone, userid,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Auto-approve access for the creating doctor
        const accessRef = db.collection('access_requests').doc(`${req.user.id}_${patientRef.id}`);
        batch.set(accessRef, {
            doctor_id: req.user.id, patient_id: patientRef.id, status: 'approved',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (prescriptionTitle && prescriptionDesc) {
            const rxRef = db.collection('health_records').doc();
            batch.set(rxRef, { patient_id: patientRef.id, record_type: 'prescription', title: prescriptionTitle, description: prescriptionDesc, created_at: admin.firestore.FieldValue.serverTimestamp() });
        }
        if (healthIssueTitle && healthIssueDesc) {
            const hiRef = db.collection('health_records').doc();
            batch.set(hiRef, { patient_id: patientRef.id, record_type: 'allergy', title: healthIssueTitle, description: healthIssueDesc, created_at: admin.firestore.FieldValue.serverTimestamp() });
        }
        await batch.commit();

        const smsMessage = `Welcome to MedGuardian! Your UserID is ${userid}. This acts as your login key.`;
        const smsResult = await sendSMS(phone, smsMessage);
        res.status(201).json({
            message: smsResult.success ? `Patient created and SMS sent via ${smsResult.provider}!` : 'Patient created successfully',
            patientId: patientRef.id,
            simulatedSms: smsResult.provider === 'simulation' ? smsMessage : null,
            smsSent: smsResult.success,
            smsProvider: smsResult.provider,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PATIENT: Get access requests ────────────────────────────────────────────
app.get('/api/access/requests', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
    try {
        const snap = await db.collection('access_requests').where('patient_id', '==', req.user.id).get();
        const requests = await Promise.all(snap.docs.map(async (doc) => {
            const data = serializeDoc(doc.id, doc.data());
            const doctorDoc = await db.collection('users').doc(data.doctor_id).get();
            data.doctor_name = doctorDoc.exists ? doctorDoc.data().name : 'Unknown Doctor';
            return data;
        }));
        res.json(requests);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PATIENT: Respond to access request ──────────────────────────────────────
app.post('/api/access/respond', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
    try {
        const { request_id, action } = req.body;
        if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
        const docRef = db.collection('access_requests').doc(request_id);
        const docSnap = await docRef.get();
        if (!docSnap.exists || docSnap.data().patient_id !== req.user.id) return res.status(404).json({ error: 'Request not found' });
        await docRef.update({ status: action });
        res.json({ message: `Request ${action}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PATIENT: Get my health records ──────────────────────────────────────────
app.get('/api/records/mine', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
    try {
        const snap = await db.collection('health_records').where('patient_id', '==', req.user.id).get();
        const records = snap.docs.map(d => serializeDoc(d.id, d.data()));
        records.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        res.json(records);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── PATIENT: Upload report ───────────────────────────────────────────────────
app.post('/api/records/upload', authenticate, requireDB, (req, res) => {
    upload.single('report')(req, res, async (uploadErr) => {
        if (uploadErr) return res.status(400).json({ error: uploadErr.message });
        if (!req.user || req.user.role !== 'patient') return res.status(403).json({ error: 'Patients only' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        try {
            let analysisText = 'AI Analysis (Simulated): Patient shows normal CBC and metabolic panel. Cholesterol is slightly elevated (LDL 130 mg/dL). No acute anomalies detected. Continue current medication plan.';
            if (process.env.GEMINI_API_KEY) {
                try {
                    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
                    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                    const fileBytes = fs.readFileSync(req.file.path);
                    const mimeType = req.file.originalname.toLowerCase().endsWith('.pdf') ? 'application/pdf' : req.file.mimetype;
                    const aiResult = await model.generateContent([
                        'You are a medical AI assistant. Extract key patient details, diagnosis, and important findings from this health report. Keep it concise and limit to 3-4 sentences.',
                        { inlineData: { data: fileBytes.toString('base64'), mimeType } },
                    ]);
                    analysisText = 'AI Analysis: ' + aiResult.response.text();
                } catch (aiErr) {
                    console.error('AI Error:', aiErr.message);
                }
            }
            const title = `Uploaded Report: ${req.file.originalname}`;
            const docRef = await db.collection('health_records').add({
                patient_id: req.user.id, record_type: 'lab_report', title, description: analysisText,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            res.status(201).json({ message: 'File uploaded and analyzed successfully', record: { id: docRef.id, patient_id: req.user.id, record_type: 'lab_report', title, description: analysisText } });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Server error' });
        }
    });
});

// ─── DOCTOR: Get patient records ──────────────────────────────────────────────
app.get('/api/records/patient/:patient_id', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'doctor') return res.status(403).json({ error: 'Doctors only' });
    try {
        const snap = await db.collection('health_records').where('patient_id', '==', req.params.patient_id).get();
        const records = snap.docs.map(d => serializeDoc(d.id, d.data()));
        records.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        res.json(records);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── ADMIN: Directory ─────────────────────────────────────────────────────────
app.get('/api/admin/directory', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    try {
        const [doctorsSnap, patientsSnap, accessSnap] = await Promise.all([
            db.collection('users').where('role', '==', 'doctor').get(),
            db.collection('users').where('role', '==', 'patient').get(),
            db.collection('access_requests').where('status', '==', 'approved').get(),
        ]);
        const patientsMap = {};
        patientsSnap.docs.forEach(d => { patientsMap[d.id] = serializeDoc(d.id, d.data()); });

        const directory = doctorsSnap.docs.map(d => {
            const doctor = serializeDoc(d.id, d.data());
            doctor.patients = accessSnap.docs
                .filter(a => a.data().doctor_id === d.id && patientsMap[a.data().patient_id])
                .map(a => patientsMap[a.data().patient_id]);
            return doctor;
        });
        directory.sort((a, b) => a.name.localeCompare(b.name));
        res.json(directory);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── ADMIN: Create doctor ─────────────────────────────────────────────────────
app.post('/api/admin/create-doctor', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    try {
        const { name, email, hospital } = req.body;
        if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
        const emailCheck = await db.collection('users').where('email', '==', email).limit(1).get();
        if (!emailCheck.empty) return res.status(400).json({ error: 'Email already exists' });
        await db.collection('users').add({
            name, email, role: 'doctor',
            hospital: hospital || 'Independent',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.status(201).json({ message: 'Doctor account created successfully. They can now log in to set up their device key.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── ADMIN: Delete doctor ─────────────────────────────────────────────────────
app.delete('/api/admin/delete-doctor/:id', authenticate, requireDB, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    try {
        const doctorId = req.params.id;
        const doctorDoc = await db.collection('users').doc(doctorId).get();
        if (!doctorDoc.exists || doctorDoc.data().role !== 'doctor') return res.status(404).json({ error: 'Doctor not found' });

        const [credsSnap, challengeSnap] = await Promise.all([
            db.collection('user_crypto_credentials').where('user_id', '==', doctorId).get(),
            db.collection('auth_challenges').where('user_id', '==', doctorId).get(),
        ]);
        const batch = db.batch();
        credsSnap.docs.forEach(d => batch.delete(d.ref));
        challengeSnap.docs.forEach(d => batch.delete(d.ref));
        batch.delete(db.collection('users').doc(doctorId));
        await batch.commit();

        await logAudit(req.user.id, `Deleted Doctor Account: ${doctorDoc.data().name} (ID ${doctorId})`, req.ip, req.headers['user-agent']);
        res.json({ message: `Doctor account for ${doctorDoc.data().name} has been removed.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ═════════════════════════════════════════════════════════════════════════════
//  SERVER START + ADMIN SEED
// ═════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    if (!db) return;
    try {
        const adminSnap = await db.collection('users').where('email', '==', 'admin@gmail.com').limit(1).get();
        if (adminSnap.empty) {
            await db.collection('users').add({
                name: 'Admin', email: 'admin@gmail.com', role: 'admin',
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log('[Firebase] Seeded admin account: admin@gmail.com');
        }
    } catch (e) {
        console.error('[Firebase] Failed to seed admin:', e.message);
    }
});
