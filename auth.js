
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;

if (!SECRET || SECRET.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters.");
}

function createToken(user) {
    return jwt.sign(
        { id: user.id, phone: user.phone },
        SECRET,
        { expiresIn: "7d" }
    );
}

function requireAuth(req, res, next) {
    const token = req.cookies?.wallet_token;

    if (!token) {
        return res.status(401).json({
            error: "Please login first."
        });
    }

    try {
        req.user = jwt.verify(token, SECRET);
        next();
    } catch {
        res.clearCookie("wallet_token");
        return res.status(401).json({
            error: "Session expired."
        });
    }
}

module.exports = {
    createToken,
    requireAuth
};