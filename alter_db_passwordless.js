/**
 * alter_db_passwordless.js
 * Run once: node alter_db_passwordless.js
 * Sets up tables for passwordless cryptographic authentication.
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
    const pool = mysql.createPool({
        host: 'localhost',
        user: 'root',
        password: process.env.DB_PASSWORD || '',
        database: 'medguardian_db',
        waitForConnections: true,
        connectionLimit: 5,
    });

    const conn = await pool.getConnection();
    try {
        const migrations = [
            // Modify users table ENUM to include 'admin'
            // We use ALTER TABLE ... MODIFY COLUMN
            `ALTER TABLE users MODIFY COLUMN role ENUM('patient', 'doctor', 'admin') NOT NULL`,
            
            // Allow password_hash to be NULL since passwordless users won't have one
            `ALTER TABLE users MODIFY COLUMN password_hash VARCHAR(255) DEFAULT NULL`,
            
            // Create user_crypto_credentials table
            `CREATE TABLE IF NOT EXISTS user_crypto_credentials (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                role ENUM('doctor', 'admin') NOT NULL,
                public_key TEXT NOT NULL,
                key_algorithm VARCHAR(50) NOT NULL,
                device_name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )`,
            
            // Create auth_challenges table for nonce validation (replay protection)
            `CREATE TABLE IF NOT EXISTS auth_challenges (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                challenge_nonce VARCHAR(255) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )`,
            
            // Create audit_logs table
            `CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                user_id INT DEFAULT NULL,
                action VARCHAR(255) NOT NULL,
                ip_address VARCHAR(45) DEFAULT NULL,
                device_info VARCHAR(255) DEFAULT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            )`
        ];

        for (const sql of migrations) {
            console.log('Running:', sql);
            await conn.query(sql);
            console.log('  ✓ done');
        }
        console.log('\n✅ Migration complete.');
    } catch (err) {
        console.error('Migration error:', err.message);
    } finally {
        conn.release();
        await pool.end();
    }
}

migrate();
