const RATE = 4799.36;
const API = "";

let currentUser = null;
let products = [];
let skip = 0;
let currentCategory = "";
let searchTimer = null;
let suggestionResults = [];

let cart = JSON.parse(localStorage.getItem("yoko_cart") || "[]");

const $ = id => document.getElementById(id);

function money(value) {
  return Math.round(Number(value) || 0).toLocaleString("en-US") + " MMK";
}

function usdToMmk(value) {
  return Math.round(Number(value) * RATE);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

async function api(url, options = {}) {
  const response = await fetch(API + url, {
    credentials:"same-origin",
    ...options
  });

  let data = {};
  try {
    data = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function setMessage(id, text, type = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "message " + type;
}

function showLogin() {
  $("loginBox").classList.remove("hidden");
  $("registerBox").classList.add("hidden");
  setMessage("authMessage","");
}

function showRegister() {
  $("loginBox").classList.add("hidden");
  $("registerBox").classList.remove("hidden");
  setMessage("authMessage","");
}

function showAuth() {
  $("authPanel").classList.remove("hidden");
  $("dashboard").classList.add("hidden");
  $("headerUser").textContent = "Guest";
}

function showDashboard() {
  $("authPanel").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
}

function switchTab(tab) {
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav button").forEach(b => b.classList.remove("active"));

  $(tab).classList.add("active");
  document.querySelector(`[data-tab="${tab}"]`).classList.add("active");

  hideAutocomplete();

  if (tab === "cart") renderCart();
  if (tab === "orders") loadOrders();

  if (tab === "deposit") {
    loadProviders();
    loadDepositHistory();
  }
}

document.querySelectorAll(".nav button").forEach(button => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

// LOGIN
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();

  const form = new FormData(e.target);

  try {
    await api("/api/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(Object.fromEntries(form))
    });

    await loadAccount(true);
  } catch(error) {
    setMessage("authMessage",error.message,"error");
  }
});

// REGISTER
$("registerForm").addEventListener("submit", async e => {
  e.preventDefault();

  const form = new FormData(e.target);

  try {
    await api("/api/register", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(Object.fromEntries(form))
    });

    await loadAccount(true);
  } catch(error) {
    setMessage("authMessage",error.message,"error");
  }
});

// ACCOUNT
async function loadAccount(showError = false) {
  let data;

  try {
    data = await api("/api/me");
  } catch(error) {
    currentUser = null;
    showAuth();

    if (showError) {
      setMessage("authMessage",error.message,"error");
    }
    return;
  }

  currentUser = data.user;
  showDashboard();
  updateAccount(data.user);

  loadProducts();
  loadCategories();
  loadProviders();
  loadDepositHistory();

  updateCartCount();
}

function updateAccount(user) {
  $("balance").textContent = money(user.balance);
  $("accountId").textContent = "#" + user.id;
  $("accountPhone").textContent = user.phone;

  $("profileName").textContent = user.name;
  $("profilePhone").textContent = user.phone;
  $("profileId").textContent = "#" + user.id;
  $("profileBalance").textContent = money(user.balance);

  $("headerUser").textContent = user.name || user.phone;
}

async function refreshBalance() {
  const data = await api("/api/me");
  currentUser = data.user;
  updateAccount(data.user);
}

// PRODUCTS
function productCard(p) {
  const price = usdToMmk(p.price);

  return `
    <article class="product">
      <img src="${escapeHTML(p.thumbnail)}"
        alt="${escapeHTML(p.title)}"
        loading="lazy"
        onerror="this.src='https://placehold.co/300x200/211a2c/ffffff?text=Product'">

      <div class="product-info">
        <div class="product-title">${escapeHTML(p.title)}</div>
        <div class="price">${money(price)}</div>
        <div class="oldprice">API sample: $${Number(p.price).toFixed(2)}</div>

        <div class="product-actions">
          <button class="btn" onclick="addToCart(${Number(p.id)})">＋ Add</button>
          <button class="btn secondary" onclick="viewProduct(${Number(p.id)})">Info</button>
        </div>
      </div>
    </article>
  `;
}

async function loadProducts(append = false) {
  try {
    const url = currentCategory
      ? `/api/products/category/${encodeURIComponent(currentCategory)}?limit=20&skip=${skip}`
      : `/api/products?limit=20&skip=${skip}`;

    const data = await api(url);

    products = append
      ? [...products,...(data.products || [])]
      : (data.products || []);

    $("products").innerHTML = products.length
      ? products.map(productCard).join("")
      : '<div class="empty">No products found.</div>';

    $("productCount").textContent = `${products.length} products loaded`;
  } catch(error) {
    $("products").innerHTML =
      `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

async function loadMore() {
  skip += 20;
  await loadProducts(true);
}

async function loadCategories() {
  try {
    const data = await api("/api/products/categories");
    const list = Array.isArray(data) ? data : data.categories || [];

    $("categories").innerHTML =
      `<button class="cat active" onclick="chooseCategory('')">All</button>` +
      list.map(c => {
        const slug = typeof c === "string" ? c : c.slug;
        const name = typeof c === "string" ? c : c.name;

        return `<button class="cat" onclick="chooseCategory('${escapeHTML(slug)}')">${escapeHTML(name)}</button>`;
      }).join("");
  } catch {
    $("categories").innerHTML =
      '<span class="small">Categories unavailable</span>';
  }
}

async function chooseCategory(category) {
  currentCategory = category;
  skip = 0;

  document.querySelectorAll(".cat").forEach(b => b.classList.remove("active"));

  const buttons = [...document.querySelectorAll(".cat")];

  const selected = buttons.find(b =>
    category
      ? b.getAttribute("onclick")?.includes(category)
      : b.textContent === "All"
  );

  if (selected) selected.classList.add("active");

  await loadProducts();
}

// SEARCH AUTOCOMPLETE
function hideAutocomplete() {
  $("autocomplete").classList.add("hidden");
  $("autocomplete").innerHTML = "";
}

function showAutocomplete(list) {
  const box = $("autocomplete");

  if (!list.length) {
    box.innerHTML = '<div class="suggestion-empty">No products found.</div>';
    box.classList.remove("hidden");
    return;
  }

  box.innerHTML = list.map(p => `
    <div class="suggestion" onclick="selectSuggestion(${Number(p.id)})">
      <img src="${escapeHTML(p.thumbnail)}" alt=""
        onerror="this.style.visibility='hidden'">
      <div class="suggestion-info">
        <div class="suggestion-title">${escapeHTML(p.title)}</div>
        <div class="suggestion-price">${money(usdToMmk(p.price))}</div>
      </div>
    </div>
  `).join("");

  box.classList.remove("hidden");
}

$("searchInput").addEventListener("input", () => {
  clearTimeout(searchTimer);

  const q = $("searchInput").value.trim();

  if (q.length < 2) {
    hideAutocomplete();
    return;
  }

  searchTimer = setTimeout(async () => {
    try {
      const data = await api("/api/products/search?q=" + encodeURIComponent(q));
      suggestionResults = data.products || [];
      showAutocomplete(suggestionResults.slice(0, 7));
    } catch {
      hideAutocomplete();
    }
  }, 300);
});

$("searchInput").addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    hideAutocomplete();
    searchProducts();
  }

  if (e.key === "Escape") {
    hideAutocomplete();
  }
});

document.addEventListener("click", e => {
  if (!e.target.closest(".search-wrap")) {
    hideAutocomplete();
  }
});

async function selectSuggestion(id) {
  const product = suggestionResults.find(p => p.id === id);

  if (!product) return;

  $("searchInput").value = product.title;
  hideAutocomplete();

  currentCategory = "";
  skip = 0;

  products = [product];

  $("products").innerHTML = products.map(productCard).join("");
  $("productCount").textContent = "1 selected product";
}

async function searchProducts() {
  const q = $("searchInput").value.trim();

  currentCategory = "";
  skip = 0;
  hideAutocomplete();

  if (!q) {
    return loadProducts();
  }

  try {
    const data = await api("/api/products/search?q=" + encodeURIComponent(q));

    products = data.products || [];

    $("products").innerHTML = products.length
      ? products.map(productCard).join("")
      : '<div class="empty">No matching products.</div>';

    $("productCount").textContent = `${products.length} search results`;
  } catch(error) {
    $("products").innerHTML =
      `<div class="empty">${escapeHTML(error.message)}</div>`;
  }
}

async function viewProduct(id) {
  try {
    const p = await api("/api/products/" + id);

    alert(
      p.title + "\n\n" +
      (p.description || "") + "\n\n" +
      "Price: " + money(usdToMmk(p.price)) +
      "\nRating: " + (p.rating || "-")
    );
  } catch(error) {
    alert(error.message);
  }
}

// CART
function saveCart() {
  localStorage.setItem("yoko_cart",JSON.stringify(cart));
  updateCartCount();
}

function updateCartCount() {
  $("cartCount").textContent =
    cart.reduce((s,i) => s + i.quantity,0);
}

function addToCart(id) {
  const existing = cart.find(i => i.product_id === id);

  if (existing) {
    if (existing.quantity >= 10) {
      return alert("Maximum quantity is 10.");
    }
    existing.quantity++;
  } else {
    cart.push({product_id:id,quantity:1});
  }

  saveCart();
  alert("Added to cart.");
}

function renderCart() {
  if (!cart.length) {
    $("cartItems").innerHTML =
      '<div class="empty">Your cart is empty.</div>';

    $("cartSummary").classList.add("hidden");
    return;
  }

  let total = 0;

  $("cartItems").innerHTML = cart.map(item => {
    const p = products.find(x => x.id === item.product_id);

    if (!p) return "";

    const price = usdToMmk(p.price);
    total += price * item.quantity;

    return `
      <div class="cart-item">
        <img src="${escapeHTML(p.thumbnail)}" alt="">
        <div class="info">
          <strong>${escapeHTML(p.title)}</strong>
          <div class="small">${money(price)} each</div>

          <div class="qty">
            <button onclick="changeQty(${p.id},-1)">−</button>
            <span>${item.quantity}</span>
            <button onclick="changeQty(${p.id},1)">＋</button>
            <span class="link" onclick="removeCart(${p.id})">Remove</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  $("cartTotal").textContent = money(total);
  $("cartSummary").classList.remove("hidden");
}

function changeQty(id, delta) {
  const item = cart.find(i => i.product_id === id);

  if (!item) return;

  item.quantity += delta;

  if (item.quantity < 1) {
    cart = cart.filter(i => i.product_id !== id);
  }

  if (item.quantity > 10) {
    item.quantity = 10;
  }

  saveCart();
  renderCart();
}

function removeCart(id) {
  cart = cart.filter(i => i.product_id !== id);
  saveCart();
  renderCart();
}

// CHECKOUT
async function checkout() {
  if (!cart.length) return;

  const button = $("checkoutBtn");

  button.disabled = true;
  button.textContent = "Processing...";

  setMessage("cartMessage","Checking wallet and product prices...");

  try {
    const result = await api("/api/shop/orders", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({items:cart})
    });

    cart = [];
    saveCart();
    renderCart();

    await refreshBalance();

    setMessage(
      "cartMessage",
      `Order #${result.order_id} submitted. Total ${money(result.total_amount)}. Remaining balance: ${money(result.balance)}.`,
      "success"
    );

    await loadOrders();

  } catch(error) {
    setMessage("cartMessage",error.message,"error");
  } finally {
    button.disabled = false;
    button.textContent = "Checkout with Wallet";
  }
}

// ORDER STATUS
function statusClass(status) {
  const value = String(status || "").toUpperCase();

  if (value === "APPROVED") return "approved";
  if (value === "REJECTED") return "rejected";

  return "pending";
}

async function loadOrders() {
  $("ordersList").textContent = "Loading orders...";

  try {
    const data = await api("/api/shop/orders");

    if (!data.orders || !data.orders.length) {
      $("ordersList").innerHTML =
        '<div class="empty">No orders yet.</div>';
      return;
    }

    $("ordersList").innerHTML = data.orders.map(o => `
      <div class="order">
        <div class="order-top">
          <strong>Order #${o.id}</strong>
          <span class="badge ${statusClass(o.status)}">
            ${escapeHTML(o.status)}
          </span>
        </div>

        <div class="order-total">${money(o.total_amount)}</div>

        <div class="small">${escapeHTML(o.created_at)}</div>

        <div class="order-actions">
          <button class="btn secondary" onclick="orderDetails(${o.id})">
            View Details →
          </button>
        </div>
      </div>
    `).join("");

  } catch(error) {
    $("ordersList").textContent = error.message;
  }
}

async function orderDetails(id) {
  try {
    const data = await api("/api/shop/orders/" + id);
    const order = data.order;
    const items = data.items || [];

    $("orderDetailsContent").innerHTML = `
      <div class="order-top">
        <strong>Order #${order.id}</strong>
        <span class="badge ${statusClass(order.status)}">
          ${escapeHTML(order.status)}
        </span>
      </div>

      <p class="small">${escapeHTML(order.created_at)}</p>

      <div>
        ${items.map(item => `
          <div class="detail-item">
            <img src="${escapeHTML(item.thumbnail || "")}" alt="">
            <div class="detail-info">
              <strong>${escapeHTML(item.title)}</strong>
              <div class="small">
                ${money(item.unit_price_mmk)} × ${Number(item.quantity)}
              </div>
            </div>
            <strong>${money(item.unit_price_mmk * item.quantity)}</strong>
          </div>
        `).join("")}
      </div>

      <div class="detail-total">
        <span>Total</span>
        <span>${money(order.total_amount)}</span>
      </div>
    `;

    $("orderModal").classList.remove("hidden");

  } catch(error) {
    alert(error.message);
  }
}

function closeOrderModal() {
  $("orderModal").classList.add("hidden");
}

// DEPOSIT PROVIDERS
async function loadProviders() {
  const providers = [
    {value:"KBZPay",label:"KBZPay"},
    {value:"WavePay",label:"WavePay"},
    {value:"AYA Pay",label:"AYA Pay"}
  ];

  $("provider").innerHTML =
    '<option value="">Select Provider</option>' +
    providers.map(p =>
      `<option value="${p.value}">${p.label}</option>`
    ).join("");
}

// DEPOSIT SUBMIT
$("depositForm").addEventListener("submit", async e => {
  e.preventDefault();

  const button = $("depositButton");
  const file = $("receipt").files[0];

  if (!file) {
    setMessage("depositMessage","Please select a receipt image.","error");
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    setMessage("depositMessage","Maximum receipt size is 5 MB.","error");
    return;
  }

  button.disabled = true;
  button.textContent = "Submitting...";

  try {
    const form = new FormData(e.target);

    await api("/api/deposits", {
      method:"POST",
      body:form
    });

    setMessage(
      "depositMessage",
      "Deposit request submitted. Waiting for admin verification.",
      "success"
    );

    e.target.reset();
    await loadDepositHistory();

  } catch(error) {
    setMessage("depositMessage",error.message,"error");
  } finally {
    button.disabled = false;
    button.textContent = "Submit Deposit Request";
  }
});

async function loadDepositHistory() {
  try {
    const data = await api("/api/deposits/history");

    const list = Array.isArray(data)
      ? data
      : data.deposits || data.history || [];

    if (!list.length) {
      $("depositHistory").innerHTML =
        '<div class="empty">No deposit history.</div>';
      return;
    }

    $("depositHistory").innerHTML = list.map(d => `
      <div class="order">
        <strong>${escapeHTML(d.provider)}</strong>
        <p>${money(d.amount)}</p>
        <span class="badge ${statusClass(d.status)}">
          ${escapeHTML(d.status)}
        </span>
        <div class="small">${escapeHTML(d.created_at || "")}</div>
      </div>
    `).join("");

  } catch(error) {
    $("depositHistory").textContent = error.message;
  }
}

// LOGOUT
async function logout() {
  try {
    await api("/api/logout",{method:"POST"});
  } catch {}

  currentUser = null;
  showAuth();
}

// START
showAuth();
loadAccount();
