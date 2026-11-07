const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const fs = require("fs");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;

const adminIds = (process.env.ADMIN_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

let bot = null;

// ===============================
// DATABASE HELPERS
// ===============================

function getDeposit(id) {
    return db.prepare(`
        SELECT d.*, u.name AS customer_name,
               u.phone AS customer_phone
        FROM deposits d
        JOIN users u ON u.id = d.user_id
        WHERE d.id = ?
    `).get(id);
}

function getOrder(id) {
    const order = db.prepare(`
        SELECT o.*, u.name AS customer_name,
               u.phone AS customer_phone
        FROM orders o
        JOIN users u ON u.id = o.user_id
        WHERE o.id = ?
    `).get(id);

    if (!order) return null;

    const items = db.prepare(`
        SELECT title, unit_price_mmk, quantity
        FROM order_items
        WHERE order_id = ?
    `).all(id);

    return { ...order, items };
}

// ===============================
// DEPOSIT NOTIFICATION
// ===============================

async function notifyDeposit(depositId) {
    if (!bot || adminIds.length === 0) return;

    const deposit = getDeposit(depositId);

    if (!deposit) {
        console.log("Deposit not found:", depositId);
        return;
    }

    const caption = [
        "💰 NEW DEPOSIT REQUEST",
        "",
        `🆔 Deposit: #${deposit.id}`,
        `👤 Customer: ${deposit.customer_name}`,
        `📱 Phone: ${deposit.customer_phone}`,
        `🏦 Provider: ${deposit.provider}`,
        `📞 Sender Phone: ${deposit.sender_phone}`,
        `💵 Amount: ${Number(deposit.amount).toLocaleString()} MMK`,
        `📌 Status: ${deposit.status}`,
        "",
        "Choose an action:"
    ].join("\n");

    const options = {
        reply_markup: {
            inline_keyboard: [[
                {
                    text: "✅ APPROVE",
                    callback_data: `dep:approve:${deposit.id}`
                },
                {
                    text: "❌ REJECT",
                    callback_data: `dep:reject:${deposit.id}`
                }
            ]]
        }
    };

    for (const adminId of adminIds) {
        try {
            const receipt = deposit.receipt
                ? path.join(__dirname, "uploads", path.basename(deposit.receipt))
                : null;

            if (receipt && fs.existsSync(receipt)) {
                await bot.sendPhoto(adminId, receipt, {
                    caption,
                    ...options
                });
            } else {
                await bot.sendMessage(adminId, caption, options);
            }
        } catch (error) {
            console.error(
                "Deposit notification failed:",
                error.message
            );
        }
    }
}

// ===============================
// ORDER NOTIFICATION
// ===============================

async function notifyOrder(orderId) {
    if (!bot || adminIds.length === 0) return;

    const order = getOrder(orderId);

    if (!order) {
        console.log("Order not found:", orderId);
        return;
    }

    const itemLines = order.items.map((item, index) => {
        const subtotal =
            Number(item.unit_price_mmk) * Number(item.quantity);

        return [
            `${index + 1}. ${item.title}`,
            `   ${item.quantity} × ${Number(item.unit_price_mmk).toLocaleString()} MMK`,
            `   Subtotal: ${subtotal.toLocaleString()} MMK`
        ].join("\n");
    });

    const message = [
        "🛒 NEW SHOP ORDER",
        "",
        `🆔 Order: #${order.id}`,
        `👤 Customer: ${order.customer_name}`,
        `📱 Phone: ${order.customer_phone}`,
        "",
        "📦 ORDER ITEMS",
        ...itemLines,
        "",
        `💰 TOTAL: ${Number(order.total_amount).toLocaleString()} MMK`,
        `📌 Status: ${order.status}`,
        "",
        "Choose an action:"
    ].join("\n");

    for (const adminId of adminIds) {
        try {
            await bot.sendMessage(adminId, message, {
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: "✅ APPROVE ORDER",
                            callback_data: `ord:approve:${order.id}`
                        },
                        {
                            text: "❌ REJECT ORDER",
                            callback_data: `ord:reject:${order.id}`
                        }
                    ]]
                }
            });
        } catch (error) {
            console.error(
                "Order notification failed:",
                error.message
            );
        }
    }
}

// ===============================
// PROCESS DEPOSIT
// ===============================

function processDeposit(depositId, action, adminId) {
    return db.transaction(() => {
        const deposit = db.prepare(`
            SELECT * FROM deposits WHERE id = ?
        `).get(depositId);

        if (!deposit) {
            return {
                ok: false,
                message: "Deposit not found."
            };
        }

        if (deposit.status !== "PENDING") {
            return {
                ok: false,
                message: `Already processed: ${deposit.status}`
            };
        }

        const status = action === "approve"
            ? "APPROVED"
            : "REJECTED";

        db.prepare(`
            UPDATE deposits
            SET status = ?, admin_id = ?
            WHERE id = ? AND status = 'PENDING'
        `).run(status, adminId, depositId);

        if (action === "approve") {
            db.prepare(`
                UPDATE users
                SET balance = balance + ?
                WHERE id = ?
            `).run(deposit.amount, deposit.user_id);

            const user = db.prepare(`
                SELECT balance FROM users WHERE id = ?
            `).get(deposit.user_id);

            db.prepare(`
                INSERT INTO transactions
                (user_id, deposit_id, type, amount, balance_after)
                VALUES (?, ?, 'DEPOSIT', ?, ?)
            `).run(
                deposit.user_id,
                depositId,
                deposit.amount,
                user.balance
            );

            return {
                ok: true,
                status,
                balance: user.balance
            };
        }

        return {
            ok: true,
            status
        };
    })();
}

// ===============================
// PROCESS ORDER
// ===============================

function processOrder(orderId, action, adminId) {
    return db.transaction(() => {
        const order = db.prepare(`
            SELECT * FROM orders WHERE id = ?
        `).get(orderId);

        if (!order) {
            return {
                ok: false,
                message: "Order not found."
            };
        }

        if (order.status !== "PENDING") {
            return {
                ok: false,
                message: `Already processed: ${order.status}`
            };
        }

        const status = action === "approve"
            ? "APPROVED"
            : "REJECTED";

        const update = db.prepare(`
            UPDATE orders
            SET status = ?
            WHERE id = ? AND status = 'PENDING'
        `).run(status, orderId);

        if (update.changes !== 1) {
            return {
                ok: false,
                message: "Order already processed."
            };
        }

        // Rejection means refund the customer.
        if (action === "reject") {
            db.prepare(`
                UPDATE users
                SET balance = balance + ?
                WHERE id = ?
            `).run(order.total_amount, order.user_id);

            const user = db.prepare(`
                SELECT balance FROM users WHERE id = ?
            `).get(order.user_id);

            // Mark the original purchase transaction as refunded.
            db.prepare(`
                UPDATE transactions
                SET type = 'REFUND',
                    amount = ?,
                    balance_after = ?
                WHERE order_id = ?
            `).run(
                order.total_amount,
                user.balance,
                orderId
            );

            return {
                ok: true,
                status,
                balance: user.balance
            };
        }

        return {
            ok: true,
            status
        };
    })();
}

// ===============================
// TELEGRAM CALLBACK HANDLER
// ===============================

async function handleCallback(query) {
    const adminId = String(query.from.id);

    if (!adminIds.includes(adminId)) {
        await bot.answerCallbackQuery(query.id, {
            text: "You are not authorized."
        });
        return;
    }

    const parts = String(query.data || "").split(":");

    if (
        parts.length !== 3 ||
        !["dep", "ord"].includes(parts[0])
    ) {
        await bot.answerCallbackQuery(query.id, {
            text: "Invalid request."
        });
        return;
    }

    const type = parts[0];
    const action = parts[1];
    const id = Number(parts[2]);

    if (
        !["approve", "reject"].includes(action) ||
        !Number.isSafeInteger(id) ||
        id < 1
    ) {
        await bot.answerCallbackQuery(query.id, {
            text: "Invalid request."
        });
        return;
    }

    try {
        const result = type === "dep"
            ? processDeposit(id, action, adminId)
            : processOrder(id, action, adminId);

        if (!result.ok) {
            await bot.answerCallbackQuery(query.id, {
                text: result.message,
                show_alert: true
            });
            return;
        }

        await bot.answerCallbackQuery(query.id, {
            text: result.status
        });

        const oldText =
            query.message.caption ||
            query.message.text ||
            "";

        const statusText = result.status === "APPROVED"
            ? "✅ APPROVED"
            : "❌ REJECTED";

        const updatedText = [
            oldText,
            "",
            statusText,
            `Admin ID: ${adminId}`,
            result.balance !== undefined
                ? `New Balance: ${Number(result.balance).toLocaleString()} MMK`
                : ""
        ].filter(Boolean).join("\n");

        const messageOptions = {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: {
                inline_keyboard: []
            }
        };

        if (query.message.caption !== undefined) {
            await bot.editMessageCaption(
                updatedText,
                messageOptions
            );
        } else {
            await bot.editMessageText(
                updatedText,
                messageOptions
            );
        }

    } catch (error) {
        console.error("Admin action failed:", error);

        try {
            await bot.answerCallbackQuery(query.id, {
                text: "Something went wrong.",
                show_alert: true
            });
        } catch (_) {}
    }
}

// ===============================
// START BOT
// ===============================

function startAdminBot() {
    if (bot) return bot;

    if (!BOT_TOKEN) {
        console.log("Telegram bot token missing.");
        return null;
    }

    if (adminIds.length === 0) {
        console.log("ADMIN_IDS missing.");
        return null;
    }

    bot = new TelegramBot(BOT_TOKEN, {
        polling: true
    });

    bot.on("callback_query", handleCallback);

    bot.on("polling_error", error => {
        console.error("Telegram polling error:", error.message);
    });

    console.log("Admin Telegram Bot started.");

    return bot;
}

module.exports = {
    startAdminBot,
    notifyDeposit,
    notifyOrder
};