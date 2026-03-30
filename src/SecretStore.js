import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export default class SecretStore {
    #masterKey;
    #filePath;
    #secrets = {};

    constructor(filePath = "./storage/local-settings.enc.json") {
        this.#filePath = filePath;
    }

    async init() {
        this.#masterKey = await this.#loadMasterKey();
        await this.#load();
    }

    async setSecret(name, value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", this.#masterKey, iv);
        let encrypted = cipher.update(value, "utf8", "hex");
        encrypted += cipher.final("hex");
        const tag = cipher.getAuthTag().toString("hex");
        this.#secrets[name] = { iv: iv.toString("hex"), tag, ciphertext: encrypted };
        await this.#save();
    }

    getSecret(name) {
        const entry = this.#secrets[name];
        if (!entry) {
            return "";
        }
        try {
            const decipher = crypto.createDecipheriv(
                "aes-256-gcm",
                this.#masterKey,
                Buffer.from(entry.iv, "hex")
            );
            decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
            let decrypted = decipher.update(entry.ciphertext, "hex", "utf8");
            decrypted += decipher.final("utf8");
            return decrypted;
        } catch {
            console.error(`Failed to decrypt secret: ${name}`);
            return "";
        }
    }

    hasSecret(name) {
        return !!this.#secrets[name];
    }

    async removeSecret(name) {
        delete this.#secrets[name];
        await this.#save();
    }

    async rotateKey() {
        const newKey = crypto.randomBytes(32);
        const keyPath = path.join(path.dirname(this.#filePath), ".master_key");
        const backupKeyPath = keyPath + ".bak";
        const backupDataPath = this.#filePath + ".bak";

        // Decrypt all secrets with old key, re-encrypt with new key
        const reEncrypted = {};
        for (const [name] of Object.entries(this.#secrets)) {
            const plainValue = this.getSecret(name);
            if (!plainValue) continue;

            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv("aes-256-gcm", newKey, iv);
            let encrypted = cipher.update(plainValue, "utf8", "hex");
            encrypted += cipher.final("hex");
            const tag = cipher.getAuthTag().toString("hex");
            reEncrypted[name] = { iv: iv.toString("hex"), tag, ciphertext: encrypted };
        }

        // Backup current files before writing
        try { await fs.copyFile(keyPath, backupKeyPath); } catch { /* no existing key file */ }
        try { await fs.copyFile(this.#filePath, backupDataPath); } catch { /* no existing data file */ }

        // Write new key first, then new encrypted data
        try {
            await fs.writeFile(keyPath, newKey.toString("hex"), "utf8");
            this.#secrets = reEncrypted;
            this.#masterKey = newKey;
            await this.#save();
        } catch (err) {
            // Restore backups on failure
            try { await fs.copyFile(backupKeyPath, keyPath); } catch { /* best effort */ }
            try { await fs.copyFile(backupDataPath, this.#filePath); } catch { /* best effort */ }
            await this.#load(); // reload old data
            throw new Error(`Key rotation failed, restored backups: ${err.message}`);
        }

        // Clean up backups
        try { await fs.unlink(backupKeyPath); } catch { /* ok */ }
        try { await fs.unlink(backupDataPath); } catch { /* ok */ }

        console.info("Master key rotated successfully");
        return newKey.toString("hex");
    }

    async #load() {
        try {
            const data = await fs.readFile(this.#filePath, "utf8");
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object") {
                this.#secrets = parsed;
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error(`Could not load encrypted settings: ${error.message}`);
            }
            this.#secrets = {};
        }
    }

    async #save() {
        const directory = path.dirname(this.#filePath);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(this.#filePath, JSON.stringify(this.#secrets, null, 2), "utf8");
    }

    async #loadMasterKey() {
        // 1. Docker secret file
        try {
            const key = await fs.readFile("/run/secrets/categorizer_master_key", "utf8");
            const trimmed = key.trim();
            if (trimmed.length === 64) {
                return Buffer.from(trimmed, "hex");
            }
        } catch { /* not available */ }

        // 2. Environment variable
        if (process.env.CATEGORIZER_MASTER_KEY) {
            return Buffer.from(process.env.CATEGORIZER_MASTER_KEY, "hex");
        }

        // 3. Auto-generate and persist
        const keyPath = path.join(path.dirname(this.#filePath), ".master_key");
        try {
            const existing = await fs.readFile(keyPath, "utf8");
            const trimmed = existing.trim();
            if (trimmed.length === 64) {
                return Buffer.from(trimmed, "hex");
            }
        } catch { /* not found */ }

        const newKey = crypto.randomBytes(32);
        await fs.mkdir(path.dirname(keyPath), { recursive: true });
        await fs.writeFile(keyPath, newKey.toString("hex"), "utf8");
        console.info("Generated new master key for secret encryption");
        return newKey;
    }
}
