
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");

fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "wallet.db");
let database;
let inTransaction = false;

function save() {
    const temp = dbPath + ".tmp";
    fs.writeFileSync(temp, Buffer.from(database.export()));
    fs.renameSync(temp, dbPath);
}

async function initialize() {
    const SQL = await initSqlJs();

    if (fs.existsSync(dbPath)) {
        database = new SQL.Database(
            fs.readFileSync(dbPath)
        );
    } else {
        database = new SQL.Database();
    }

    database.run("PRAGMA foreign_keys = ON");

    database.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            balance INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            amount INTEGER NOT NULL,
            sender_phone TEXT NOT NULL,
            receipt TEXT NOT NULL,
            status TEXT DEFAULT 'PENDING',
            admin_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            deposit_id INTEGER UNIQUE,
            type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(deposit_id) REFERENCES deposits(id)
        );
    `);

    save();
    console.log("Database initialized!");
}

function prepare(sql) {
    return {
        get(...params) {
            const stmt = database.prepare(sql);
            try {
                stmt.bind(params);
                return stmt.step() ? stmt.getAsObject() : undefined;
            } finally {
                stmt.free();
            }
        },

        all(...params) {
            const stmt = database.prepare(sql);
            const rows = [];
            try {
                stmt.bind(params);
                while (stmt.step()) rows.push(stmt.getAsObject());
                return rows;
            } finally {
                stmt.free();
            }
        },

        run(...params) {
            database.run(sql, params);

            const result = {
                changes: database.getRowsModified(),
                lastInsertRowid: database.exec(
                    "SELECT last_insert_rowid() AS id"
                )[0]?.values[0][0]
            };

            if (!inTransaction) save();
            return result;
        }
    };
}

const db = {
    ready: initialize(),

    exec(sql) {
        database.exec(sql);
        if (!inTransaction) save();
    },

    prepare,

    transaction(callback) {
        return (...args) => {
            database.run("BEGIN TRANSACTION");
            inTransaction = true;

            try {
                const result = callback(...args);
                database.run("COMMIT");
                inTransaction = false;
                save();
                return result;
            } catch (error) {
                database.run("ROLLBACK");
                inTransaction = false;
                throw error;
            }
        };
    }
};

module.exports = db;
