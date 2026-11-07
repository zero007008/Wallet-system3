
const express = require("express");
const router = express.Router();

const db = require("./db");
const { requireAuth } = require("./auth");
const { notifyOrder } = require("./admin-bot");

// =====================================
// CONFIG
// =====================================

const USD_TO_MMK = 4799.36;
const PRODUCT_API = "https://dummyjson.com/products";

// =====================================
// DATABASE INITIALIZATION
// =====================================

const schemaReady = db.ready.then(() => {
    db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            total_amount REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            product_id INTEGER,
            title TEXT NOT NULL,
            unit_price_mmk REAL NOT NULL,
            quantity INTEGER NOT NULL
        );
    `);

    const columns = db.prepare(`
        PRAGMA table_info(transactions)
    `).all();

    const hasOrderId = columns.some(
        column => column.name === "order_id"
    );

    if (!hasOrderId) {
        db.exec(`
            ALTER TABLE transactions
            ADD COLUMN order_id INTEGER
        `);
    }

    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_order_id
        ON transactions(order_id)
        WHERE order_id IS NOT NULL
    `);

    console.log("Shop database initialized.");
});

// =====================================
// PRODUCT HELPER
// =====================================

async function getProduct(productId) {
    const response = await fetch(
        `${PRODUCT_API}/${encodeURIComponent(productId)}`
    );

    if (!response.ok) {
        throw new Error("Product not found.");
    }

    const product = await response.json();

    if (
        !product ||
        !Number.isSafeInteger(Number(product.id)) ||
        typeof product.price !== "number" ||
        !Number.isFinite(product.price) ||
        product.price <= 0
    ) {
        throw new Error("Invalid product information.");
    }

    return product;
}

// =====================================
// EXCHANGE RATE
// =====================================

router.get("/rate", async (req, res) => {
    try {
        await schemaReady;

        res.json({
            success: true,
            usd_to_mmk: USD_TO_MMK,
            currency: "MMK"
        });

    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// =====================================
// CREATE ORDER
// =====================================

router.post("/orders", requireAuth, async (req, res) => {
    try {
        await schemaReady;

        const userId = Number(req.user.id);
        const items = req.body.items;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                error: "Your cart is empty."
            });
        }

        if (items.length > 20) {
            return res.status(400).json({
                error: "Too many products."
            });
        }

        const orderItems = [];

        // Validate cart and verify product prices.
        for (const item of items) {

            console.log(
                "CHECKOUT ITEM:",
                JSON.stringify(item)
            );

            // Frontend uses product_id.
            // Also support id and productId.
            const productId = Number(
                item.product_id ??
                item.productId ??
                item.id
            );

            const quantity = Number(
                item.quantity ?? item.qty ?? 1
            );

            if (
                !Number.isSafeInteger(productId) ||
                productId < 1 ||
                !Number.isSafeInteger(quantity) ||
                quantity < 1 ||
                quantity > 10
            ) {
                console.log("INVALID CHECKOUT DATA:", {
                    received: item,
                    productId,
                    quantity
                });

                return res.status(400).json({
                    error: `Invalid product or quantity. ID=${productId}, Qty=${quantity}`
                });
            }

            const product = await getProduct(productId);

            const unitPrice = Math.round(
                product.price * USD_TO_MMK
            );

            orderItems.push({
                productId: Number(product.id),
                title: product.title,
                unitPrice,
                quantity
            });
        }

        const totalAmount = orderItems.reduce(
            (total, item) =>
                total + item.unitPrice * item.quantity,
            0
        );

        if (
            !Number.isSafeInteger(totalAmount) ||
            totalAmount <= 0
        ) {
            return res.status(400).json({
                error: "Invalid order amount."
            });
        }

        // =================================
        // ATOMIC WALLET CHECKOUT
        // =================================

        const result = db.transaction(() => {

            const user = db.prepare(`
                SELECT id, balance
                FROM users
                WHERE id = ?
            `).get(userId);

            if (!user) {
                throw new Error("User not found.");
            }

            const balance = Number(user.balance || 0);

            if (balance < totalAmount) {
                throw new Error(
                    "Insufficient wallet balance."
                );
            }

            const newBalance = balance - totalAmount;

            db.prepare(`
                UPDATE users
                SET balance = ?
                WHERE id = ?
            `).run(newBalance, userId);

            db.prepare(`
                INSERT INTO orders (
                    user_id,
                    total_amount,
                    status
                )
                VALUES (?, ?, 'PENDING')
            `).run(userId, totalAmount);

            const order = db.prepare(`
                SELECT last_insert_rowid() AS id
            `).get();

            const orderId = order.id;

            const insertItem = db.prepare(`
                INSERT INTO order_items (
                    order_id,
                    product_id,
                    title,
                    unit_price_mmk,
                    quantity
                )
                VALUES (?, ?, ?, ?, ?)
            `);

            for (const item of orderItems) {
                insertItem.run(
                    orderId,
                    item.productId,
                    item.title,
                    item.unitPrice,
                    item.quantity
                );
            }

            db.prepare(`
                INSERT INTO transactions (
                    user_id,
                    order_id,
                    type,
                    amount,
                    balance_after
                )
                VALUES (?, ?, 'PURCHASE', ?, ?)
            `).run(
                userId,
                orderId,
                -totalAmount,
                newBalance
            );

            return {
                orderId,
                totalAmount,
                balance: newBalance
            };
        })();

        // Notify the existing Telegram admin bot.
        Promise.resolve(
            notifyOrder(result.orderId)
        ).catch(error => {
            console.error(
                "Order notification failed:",
                error.message
            );
        });

        res.status(201).json({
            success: true,
            message: "Order created successfully.",

            // Compatible with frontend app.js
            order_id: result.orderId,
            total_amount: result.totalAmount,
            balance: result.balance,

            // Also provide camelCase aliases.
            orderId: result.orderId,
            total: result.totalAmount,

            status: "PENDING"
        });

    } catch (error) {
        console.error("Create order error:", error);

        let status = 500;

        if (
            error.message ===
            "Insufficient wallet balance."
        ) {
            status = 400;
        }

        if (error.message === "User not found.") {
            status = 404;
        }

        res.status(status).json({
            error: error.message ||
                "Could not create order."
        });
    }
});

// =====================================
// GET MY ORDERS
// =====================================

router.get("/orders", requireAuth, async (req, res) => {
    try {
        await schemaReady;

        const orders = db.prepare(`
            SELECT
                id,
                total_amount,
                status,
                created_at
            FROM orders
            WHERE user_id = ?
            ORDER BY id DESC
        `).all(req.user.id);

        res.json({
            success: true,
            orders
        });

    } catch (error) {
        console.error("Get orders error:", error);

        res.status(500).json({
            error: error.message
        });
    }
});

// =====================================
// GET ORDER DETAILS
// =====================================

router.get("/orders/:id", requireAuth, async (req, res) => {
    try {
        await schemaReady;

        const orderId = Number(req.params.id);

        if (
            !Number.isSafeInteger(orderId) ||
            orderId < 1
        ) {
            return res.status(400).json({
                error: "Invalid order ID."
            });
        }

        const order = db.prepare(`
            SELECT
                id,
                user_id,
                total_amount,
                status,
                created_at
            FROM orders
            WHERE id = ? AND user_id = ?
        `).get(orderId, req.user.id);

        if (!order) {
            return res.status(404).json({
                error: "Order not found."
            });
        }

        const items = db.prepare(`
            SELECT
                product_id,
                title,
                unit_price_mmk,
                quantity
            FROM order_items
            WHERE order_id = ?
        `).all(orderId);

        res.json({
            success: true,
            order,
            items
        });

    } catch (error) {
        console.error("Order details error:", error);

        res.status(500).json({
            error: error.message
        });
    }
});

// =====================================
// EXPORT
// =====================================

module.exports = router;