# Passwordless Cryptographic Authentication Plan

This document outlines the implementation plan for the highly secure, passwordless cryptographic authentication system for Doctors and Admins in MedGuardian AI.

> [!NOTE]
> **Architecture Clarification**
> The prompt specified "Existing Backend: Spring Boot" and "Java Security APIs". However, the existing MedGuardian AI project is built using a **Node.js (Express)** backend.
> This plan adapts all your security requirements to integrate seamlessly into the existing Node.js architecture using Node's native `crypto` module, completely fulfilling the cryptographic constraints without needlessly rebuilding the app in Java.

## User Review Required

> [!IMPORTANT]
> Please review the architecture adaptation above. Is it acceptable to implement the cryptographic logic using Node.js `crypto` instead of Spring Boot, to preserve the existing backend?

## Proposed Changes

### 1. Database Migrations
We will create a migration script to set up the necessary tables and modify the existing `users` table to support the `admin` role.

#### [NEW] `alter_db_passwordless.js`
- **Modify `users` table**: Update `role` ENUM to `('patient', 'doctor', 'admin')`.
- **Create `user_crypto_credentials` table**:
  - `id`, `user_id`, `role`, `public_key` (TEXT), `key_algorithm`, `device_name`, `created_at`, `last_used_at`, `is_active` (BOOLEAN).
- **Create `auth_challenges` table**:
  - `id`, `user_id`, `challenge_nonce` (VARCHAR), `expires_at` (TIMESTAMP).
  - Ensures challenges are one-time use and expire in 60 seconds (Replay attack protection).
- **Create `audit_logs` table**:
  - `id`, `timestamp`, `user_id`, `action` (e.g., "Registration", "Login Success"), `ip_address`, `device_info`.

---

### 2. Backend API Updates (Node.js)

#### [MODIFY] `server.js`
Add endpoints to support the passwordless flow and audit logging:

- **`POST /api/auth/crypto/register`**:
  - Receives `name`, `email`, `role`, `device_name`, and the base64-encoded `public_key`.
  - Creates the user (without a password hash) and stores the public key in `user_crypto_credentials`.
  - Logs the "Device Registration" event.
- **`POST /api/auth/crypto/challenge`**:
  - Receives `email`. Looks up the user.
  - Generates a cryptographically secure random nonce.
  - Stores it in `auth_challenges` with a 60-second expiry.
  - Returns the challenge.
- **`POST /api/auth/crypto/verify`**:
  - Receives `email` and the `signature`.
  - Retrieves the user's active `public_key` and the valid challenge.
  - Uses `crypto.verify` (ECDSA P-256 or RSA) to validate the signature against the challenge.
  - If valid: Deletes the challenge, updates `last_used_at`, issues a JWT, and logs "Login Success".
  - If invalid: Logs "Login Failure" and rejects.
- **`POST /api/auth/device/request`**:
  - Logs a request for a new device when a user logs in from an unregistered browser.
- **`POST /api/auth/device/approve`**:
  - Admin-only endpoint to approve a new device and accept its public key.

---

### 3. Frontend Web Crypto Implementation

#### [NEW] `js/crypto-auth.js`
A dedicated utility file for frontend cryptography:
- **`generateKeyPair()`**: Uses `window.crypto.subtle.generateKey` (ECDSA P-256) with `extractable: false`.
- **IndexedDB Storage**: Saves the `privateKey` locally in the browser's IndexedDB. Never uses `localStorage`.
- **`signChallenge(challenge)`**: Retrieves the private key from IndexedDB, signs the nonce, and returns the signature.

#### [MODIFY] `login.html`
Update the UI to support the passwordless flow:
- Remove the password field for Doctor and Admin tabs.
- **Registration**: On submit, call `crypto-auth.js` to generate keys, store the private key locally, and send the public key to `/api/auth/crypto/register`. Show success message.
- **Login**: On submit, request a challenge, sign it locally, and send the signature. Show success message on verification.
- **Device Binding UX**: Catch errors when a private key is not found in IndexedDB. Show: *"No registered cryptographic identity found on this device."* and provide a button to *"Request New Device Registration"*.

## Verification Plan

### Automated/Manual Testing
1. **Registration Flow**: Register a new Doctor. Verify the DB contains the public key and NO password hash. Verify IndexedDB holds the private key.
2. **Authentication Flow**: Log in using just the email. Verify the backend issues a challenge, the frontend signs it, and a JWT is issued within 60 seconds.
3. **Replay Protection**: Attempt to reuse a challenge or send a signature after 60 seconds. Verify the backend rejects it.
4. **Device Binding**: Open the app in an Incognito window (empty IndexedDB). Attempt to log in as the registered Doctor. Verify it fails with the "No registered cryptographic identity" message.
5. **Audit Logs**: Check the DB to ensure all login attempts (success and failure) are logged with IPs and timestamps.
