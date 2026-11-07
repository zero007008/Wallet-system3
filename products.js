
const express = require("express");
const router = express.Router();

const API = "https://dummyjson.com/products";

async function apiGet(url, res) {
    try {
        const response = await fetch(url);

        if (!response.ok) {
            return res.status(502).json({
                error: "Product API unavailable."
            });
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("Product API:", error.message);

        res.status(502).json({
            error: "Could not connect to Product API."
        });
    }
}

// Get all products
router.get("/", async (req, res) => {
    const limit = Math.min(
        Math.max(Number(req.query.limit) || 30, 1),
        100
    );

    const skip = Math.max(Number(req.query.skip) || 0, 0);

    await apiGet(`${API}?limit=${limit}&skip=${skip}`, res);
});

// Get categories
router.get("/categories", async (req, res) => {
    await apiGet(`${API}/categories`, res);
});

// Search products
router.get("/search", async (req, res) => {
    const query = String(req.query.q || "").trim();

    if (!query) {
        return res.status(400).json({
            error: "Search keyword is required."
        });
    }

    await apiGet(
        `${API}/search?q=${encodeURIComponent(query)}`,
        res
    );
});

// Get products by category
router.get("/category/:name", async (req, res) => {
    const category = encodeURIComponent(req.params.name);

    await apiGet(
        `${API}/category/${category}`,
        res
    );
});

// Get single product
router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
        return res.status(400).json({
            error: "Invalid product ID."
        });
    }

    await apiGet(`${API}/${id}`, res);
});

module.exports = router;