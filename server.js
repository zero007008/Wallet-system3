
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const shopRoutes = require("./shop");
const productRoutes = require("./products");

const db = require("./db");
const { createToken, requireAuth } = require("./auth");
const { startAdminBot } = require("./admin-bot");
const depositRoutes = require("./deposit");

const app = express();

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/deposits", depositRoutes);
app.use("/api/products", productRoutes);
app.use("/api/shop", shopRoutes);
 const cookieOptions = {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000
};
// REGISTER
app.post("/api/register", async (req, res) => {
    try {
        const { name, phone, password } = req.body;

        if (
            !name ||
            !/^09\d{7,9}$/.test(phone || "") ||
            !password ||
            password.length < 8
        ) {
            return res.status(400).json({
                error: "Invalid registration information."
            });
        }

        const existing = db.prepare(
            "SELECT id FROM users WHERE phone = ?"
        ).get(phone);

        if (existing) {
            return res.status(409).json({
                error: "Phone already registered."
            });
        }

        const hash = await bcrypt.hash(password, 12);

        const result = db.prepare(`
            INSERT INTO users (name, phone, password_hash)
            VALUES (?, ?, ?)
        `).run(name.trim(), phone, hash);

        const user = {
            id: result.lastInsertRowid,
            phone
        };

        res.cookie(
            "wallet_token",
            createToken(user),
            cookieOptions
        );

        res.json({
            success: true,
            message: "Registration successful."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Registration failed."
        });
    }
});

// LOGIN
app.post("/api/login", async (req, res) => {
    try {
        const { phone, password } = req.body;

        const user = db.prepare(
            "SELECT * FROM users WHERE phone = ?"
        ).get(phone || "");

        if (
            !user ||
            !(await bcrypt.compare(
                password || "",
                user.password_hash
            ))
        ) {
            return res.status(401).json({
                error: "Incorrect phone or password."
            });
        }

        res.cookie(
            "wallet_token",
            createToken(user),
            cookieOptions
        );

        res.json({
            success: true,
            message: "Login successful."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Login failed."
        });
    }
});

// PROFILE
app.get("/api/me", requireAuth, (req, res) => {
    const user = db.prepare(`
        SELECT id, name, phone, balance
        FROM users
        WHERE id = ?
    `).get(req.user.id);

    if (!user) {
        return res.status(404).json({
            error: "User not found."
        });
    }

    res.json({ user });
});

// LOGOUT
app.post("/api/logout", (req, res) => {
    res.clearCookie("wallet_token");
    res.json({ success: true });
});

// HEALTH
app.get("/api/health", (req, res) => {
    res.json({
        status: "online",
        application: "Wallet System",
        database: "SQLite"
    });
});

db.ready.then(() => {
    startAdminBot();

    const PORT = process.env.PORT || 8080;

    app.listen(PORT, "0.0.0.0", () => {
        console.log("Database Connected!");
        console.log(`Wallet Server running on port ${PORT}`);
    });

}).catch(error => {
    console.error("Database startup failed:", error);
});
