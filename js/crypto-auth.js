/**
 * crypto-auth.js
 * Handles Web Crypto API for Passwordless Authentication.
 * Stores private keys securely in IndexedDB.
 */

const DB_NAME = 'MedGuardianCryptoDB';
const STORE_NAME = 'user_keys';

// 1. Initialize IndexedDB
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'email' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = (e) => reject(e);
    });
}

// 2. Generate ECDSA P-256 Key Pair
async function generateKeyPair(email) {
    // Generate key pair
    const keyPair = await window.crypto.subtle.generateKey(
        {
            name: "ECDSA",
            namedCurve: "P-256"
        },
        false, // extractable: false for private key security
        ["sign", "verify"]
    );

    // Export public key to SPKI format (PEM-like) to send to server
    const exportedPublicKey = await window.crypto.subtle.exportKey(
        "spki",
        keyPair.publicKey
    );

    const exportedAsString = String.fromCharCode.apply(null, new Uint8Array(exportedPublicKey));
    const b64PublicKey = btoa(exportedAsString);
    const pemPublicKey = `-----BEGIN PUBLIC KEY-----\n${b64PublicKey}\n-----END PUBLIC KEY-----`;

    // Store Private Key in IndexedDB
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ email: email, privateKey: keyPair.privateKey });

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(pemPublicKey);
        tx.onerror = (e) => reject(e);
    });
}

// 3. Get Private Key from IndexedDB
async function getPrivateKey(email) {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(email);

    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ? request.result.privateKey : null);
        request.onerror = (e) => reject(e);
    });
}

// 4. Sign Challenge
async function signChallenge(email, challengeBase64) {
    const privateKey = await getPrivateKey(email);
    if (!privateKey) {
        throw new Error('NO_KEY_FOUND');
    }

    // Prepare the client data to sign
    const clientData = {
        challenge: challengeBase64,
        origin: window.location.origin,
        type: 'webcrypto.get'
    };

    const clientDataStr = JSON.stringify(clientData);
    const clientDataJSON = btoa(clientDataStr);
    const encoder = new TextEncoder();
    const dataToSign = encoder.encode(clientDataStr);

    // Sign the data
    const signatureBuffer = await window.crypto.subtle.sign(
        {
            name: "ECDSA",
            hash: { name: "SHA-256" },
        },
        privateKey,
        dataToSign
    );

    const signatureBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(signatureBuffer)));

    return { signature: signatureBase64, clientDataJSON: clientDataJSON };
}
