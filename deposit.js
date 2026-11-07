
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const db = require("./db");
const { requireAuth } = require("./auth");
const { notifyDeposit } = require("./admin-bot");

const router = express.Router();

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const providers = ["KBZPay", "WavePay", "AYA Pay"];

const schemaReady = db.ready.then(() => {
    const columns = db.prepare(
        "PRAGMA table_info(deposits)"
    ).all();

    if (!columns.some(c => c.name === "transaction_last6")) {
        db.exec(
            "ALTER TABLE deposits ADD COLUMN transaction_last6 TEXT"
        );
    }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, crypto.randomUUID() + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = [
            "image/jpeg",
            "image/png",
            "image/webp"
        ];

        if (!allowed.includes(file.mimetype)) {
            return cb(
                new Error("Only JPG, PNG or WEBP images are allowed.")
            );
        }

        cb(null, true);
    }
});

function removeUpload(file) {
    if (file && file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }
}

function receiptUpload(req, res, next) {
    upload.single("receipt")(req, res, error => {
        if (error) {
            return res.status(400).json({
                error: error.message
            });
        }
        next();
    });
}

router.get("/providers", (req, res) => {
    res.json({ providers });
});

router.post("/", requireAuth, receiptUpload, async (req, res) => {
    try {
        await schemaReady;

        const {
            provider,
            amount,
            sender_phone,
            transaction_last6
        } = req.body;

        const value = Number(amount);
        const phone = String(sender_phone || "").trim();
        const last6 = String(transaction_last6 || "").trim();

        if (!providers.includes(provider)) {
            removeUpload(req.file);
            return res.status(400).json({
                error: "Invalid payment provider."
            });
        }

        if (
            !Number.isSafeInteger(value) ||
            value < 1000 ||
            value > 10000000
        ) {
            removeUpload(req.file);
            return res.status(400).json({
                error: "Amount must be between 1,000 and 10,000,000 MMK."
            });
        }

        if (!/^09\d{7,9}$/.test(phone)) {
            removeUpload(req.file);
            return res.status(400).json({
                error: "Invalid sender phone number."
            });
        }

        if (!/^\d{6}$/.test(last6)) {
            removeUpload(req.file);
            return res.status(400).json({
                error: "Transaction ID must contain exactly 6 digits."
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: "Please upload a payment receipt."
            });
        }

        const result = db.prepare(`
            INSERT INTO deposits (
                user_id,
                provider,
                amount,
                sender_phone,
                transaction_last6,
                receipt,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
        `).run(
            req.user.id,
            provider,
            value,
            phone,
            last6,
            req.file.filename
        );

        // Notify Telegram admins without blocking the customer's response.
        notifyDeposit(result.lastInsertRowid).catch(error => {
            console.error("Telegram notification error:", error);
        });

        res.status(201).json({
            message: "Deposit request submitted. Waiting for admin approval.",
            deposit_id: result.lastInsertRowid,
            status: "PENDING"
        });

    } catch (error) {
        console.error("Deposit Error:", error);
        removeUpload(req.file);

        res.status(500).json({
            error: "Could not submit deposit request."
        });
    }
});

router.get("/history", requireAuth, async (req, res) => {
    try {
        await schemaReady;

        const deposits = db.prepare(`
            SELECT
                id,
                provider,
                amount,
                transaction_last6,
                status,
                created_at
            FROM deposits
            WHERE user_id = ?
            ORDER BY id DESC
        `).all(req.user.id);

        res.json({ deposits });

    } catch (error) {
        console.error("History Error:", error);

        res.status(500).json({
            error: "Could not load deposit history."
        });
    }
});

module.exports = router;