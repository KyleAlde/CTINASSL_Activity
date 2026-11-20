import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, ShoppingBag, Heart, ArrowRight, Star, Plus, Minus, X, Menu,
  SlidersHorizontal, Check, Package, Truck, ShieldCheck, Headphones,
  ChevronDown, UserRound, LogOut, LoaderCircle, LockKeyhole,
} from 'lucide-react';
import placeholderImage from './images/placeholder.svg';
import { apiRequest, API_BASE_URL } from './lib/api.js';

const localImages = import.meta.glob('./images/*.{png,jpg,jpeg,webp,avif,svg}', {
  eager: true,
  import: 'default',
});

function localImage(filename) {
  const wanted = String(filename || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
  const match = Object.entries(localImages).find(([path]) => {
    const imageName = path.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
    return imageName === wanted;
  });
  return match?.[1] || placeholderImage;
}

function resolveProductImage(image, name) {
  if (typeof image === 'string' && /^(https?:\/\/|data:)/i.test(image)) return image;
  const candidate = (image || name || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  return localImage(candidate);
}

const categories = ['All', 'Fashion', 'Accessories', 'Tech', 'Home'];

function readSavedState(key, fallback) {
  try {
    const saved = window.localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch {
    return fallback;
  }
}
const peso = (n) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 }).format(Number(n) || 0);
const isObjectId = (value) => /^[a-f\d]{24}$/i.test(String(value || ''));

function cartMapFromResponse(responseData) {
  const cart = {};
  for (const item of responseData?.items || []) {
    const productId = item.productId && typeof item.productId === 'object' ? item.productId._id : item.productId;
    if (productId) cart[String(productId)] = Number(item.quantity) || 1;
  }
  return cart;
}

function mergeCartMaps(first, second, validProductIds) {
  const result = { ...first };
  for (const [id, quantity] of Object.entries(second || {})) {
    if (validProductIds.has(String(id)) && isObjectId(id)) result[id] = (result[id] || 0) + Number(quantity || 0);
  }
  return result;
}

function App() {
  const [products, setProducts] = useState([]);
  const [catalogSource, setCatalogSource] = useState('loading');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState(() => readSavedState('skyshop-cart', {}));
  const [wishlist, setWishlist] = useState(() => readSavedState('skyshop-wishlist', []));
  const [cartOpen, setCartOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [sort, setSort] = useState('featured');
  const [notice, setNotice] = useState('');
  const [token, setToken] = useState(() => window.localStorage.getItem('skyshop-token') || '');
  const [user, setUser] = useState(() => readSavedState('skyshop-user', null));
  const [accountOpen, setAccountOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authLoading, setAuthLoading] = useState(false);
  const [authForm, setAuthForm] = useState({ firstName: '', lastName: '', email: '', password: '', phone: '' });
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutForm, setCheckoutForm] = useState({
    name: '', email: '', phone: '', addressLine1: '', addressLine2: '', city: '',
    province: '', postalCode: '', country: 'Philippines', paymentMethod: 'cash_on_delivery', notes: '',
  });
  const pendingGuestCart = useRef(null);
  const noticeTimer = useRef(null);

  const showNotice = useCallback((message) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3200);
  }, []);

  const reloadProducts = useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError('');
    try {
      const result = await apiRequest('/products?limit=100&sort=featured');
      const apiProducts = (result.data || []).map((product) => ({
        ...product,
        image: resolveProductImage(product.image, product.name),
      }));
      setProducts(apiProducts);
      setCatalogSource('api');
      // Drop stale guest cart entries after switching from the original demo IDs to MongoDB IDs.
      if (!window.localStorage.getItem('skyshop-token')) {
        const validIds = new Set(apiProducts.map((product) => String(product._id)));
        setCart((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => validIds.has(String(id)))));
      }
    } catch (error) {
      setProducts([]);
      setCatalogSource('demo');
      setCatalogError(error.message);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => { reloadProducts(); }, [reloadProducts]);

  // Verify any saved login after the app starts.
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    apiRequest('/auth/me').then((result) => {
      if (!active) return;
      setUser(result.data);
      window.localStorage.setItem('skyshop-user', JSON.stringify(result.data));
    }).catch(() => {
      if (!active) return;
      window.localStorage.removeItem('skyshop-token');
      window.localStorage.removeItem('skyshop-user');
      setToken('');
      setUser(null);
    });
    return () => { active = false; };
    // Initial session validation only; the endpoint is called again after a new login via the cart sync effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a signed-in user's cart in MongoDB. On first login, merge valid guest items into their server cart.
  const syncRemoteCart = useCallback(async () => {
    try {
      const result = await apiRequest('/carts/me');
      let serverCart = cartMapFromResponse(result.data);
      const guestCart = pendingGuestCart.current;
      pendingGuestCart.current = null;
      if (guestCart && Object.keys(guestCart).length) {
        const ids = new Set(products.map((product) => String(product._id)));
        const merged = mergeCartMaps(serverCart, guestCart, ids);
        if (Object.keys(merged).length) {
          const saved = await apiRequest('/carts/me', {
            method: 'PUT',
            body: { items: Object.entries(merged).map(([productId, quantity]) => ({ productId, quantity })) },
          });
          serverCart = cartMapFromResponse(saved.data);
        }
      }
      setCart(serverCart);
    } catch (error) {
      if (error.status === 401) {
        window.localStorage.removeItem('skyshop-token');
        window.localStorage.removeItem('skyshop-user');
        setToken('');
        setUser(null);
        setCart(readSavedState('skyshop-cart', {}));
      }
      showNotice(error.message || 'Could not load your saved cart.');
    }
  }, [products, showNotice]);

  useEffect(() => {
    if (token && catalogSource === 'api') syncRemoteCart();
  }, [token, catalogSource, syncRemoteCart]);

  // If a saved token is rejected, reconcile the local guest cart against the live catalogue.
  useEffect(() => {
    if (token || catalogSource !== 'api') return;
    const validIds = new Set(products.map((product) => String(product._id)));
    setCart((previous) => {
      const next = Object.fromEntries(Object.entries(previous).filter(([id]) => validIds.has(String(id))));
      return Object.keys(next).length === Object.keys(previous).length ? previous : next;
    });
  }, [token, catalogSource, products]);

  // Guest carts stay in localStorage. Signed-in carts are stored in MongoDB instead.
  useEffect(() => {
    if (!token) {
      try { window.localStorage.setItem('skyshop-cart', JSON.stringify(cart)); } catch { /* storage may be unavailable */ }
    }
  }, [cart, token]);
  useEffect(() => {
    try { window.localStorage.setItem('skyshop-wishlist', JSON.stringify(wishlist)); } catch { /* storage may be unavailable */ }
  }, [wishlist]);

  const visibleProducts = useMemo(() => {
    let list = products.filter((product) =>
      (category === 'All' || product.category === category) &&
      product.name.toLowerCase().includes(search.toLowerCase())
    );
    if (sort === 'low') list = [...list].sort((a, b) => a.price - b.price);
    if (sort === 'high') list = [...list].sort((a, b) => b.price - a.price);
    if (sort === 'rating') list = [...list].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    return list;
  }, [products, category, search, sort]);

  const cartItems = products.filter((product) => cart[product._id]).map((product) => ({ ...product, quantity: cart[product._id] }));
  const cartCount = Object.values(cart).reduce((sum, quantity) => sum + Number(quantity || 0), 0);
  const subtotal = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  async function addToCart(product) {
    const newQuantity = Number(cart[product._id] || 0) + 1;
    if ((!token || catalogSource !== 'api') && Number.isFinite(Number(product.stock)) && newQuantity > Number(product.stock)) {
      showNotice(`Only ${product.stock} unit(s) of ${product.name} are in stock.`);
      return;
    }
    if (token && catalogSource === 'api' && isObjectId(product._id)) {
      try {
        const result = await apiRequest(`/carts/me/items/${product._id}`, { method: 'PATCH', body: { quantity: newQuantity } });
        setCart(cartMapFromResponse(result.data));
      } catch (error) {
        showNotice(error.message);
        return;
      }
    } else {
      setCart((previous) => ({ ...previous, [product._id]: (previous[product._id] || 0) + 1 }));
    }
    showNotice(`${product.name} added to your bag${!token ? ' · sign in to sync across devices' : ''}`);
  }

  async function setCartQuantity(id, quantity) {
    const nextQuantity = Math.max(0, Number(quantity) || 0);
    if (token && catalogSource === 'api' && isObjectId(id)) {
      try {
        const result = await apiRequest(`/carts/me/items/${id}`, { method: 'PATCH', body: { quantity: nextQuantity } });
        setCart(cartMapFromResponse(result.data));
      } catch (error) {
        showNotice(error.message);
      }
      return;
    }
    setCart((previous) => {
      const next = { ...previous };
      if (nextQuantity <= 0) delete next[id];
      else next[id] = nextQuantity;
      return next;
    });
  }

  function changeQty(id, delta) { setCartQuantity(id, (Number(cart[id]) || 0) + delta); }
  function toggleWish(id) { setWishlist((previous) => previous.includes(id) ? previous.filter((savedId) => savedId !== id) : [...previous, id]); }
  function goProducts() { document.getElementById('shop')?.scrollIntoView({ behavior: 'smooth' }); setMobileMenu(false); }

  function openAccount() {
    setAuthMode('login');
    setAccountOpen(true);
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthLoading(true);
    try {
      const body = authMode === 'register'
        ? { firstName: authForm.firstName.trim(), lastName: authForm.lastName.trim(), email: authForm.email.trim(), password: authForm.password, phone: authForm.phone.trim() }
        : { email: authForm.email.trim(), password: authForm.password };
      const result = await apiRequest(`/auth/${authMode}`, { method: 'POST', body });
      pendingGuestCart.current = { ...cart };
      window.localStorage.setItem('skyshop-token', result.token);
      window.localStorage.setItem('skyshop-user', JSON.stringify(result.data));
      setToken(result.token);
      setUser(result.data);
      setAuthForm({ firstName: '', lastName: '', email: '', password: '', phone: '' });
      setAccountOpen(false);
      setCheckoutForm((previous) => ({ ...previous, name: `${result.data.firstName} ${result.data.lastName}`.trim(), email: result.data.email, phone: result.data.phone || '' }));
      showNotice(result.message || 'You are signed in.');
    } catch (error) {
      showNotice(error.message);
    } finally {
      setAuthLoading(false);
    }
  }

  function signOut() {
    window.localStorage.removeItem('skyshop-token');
    window.localStorage.removeItem('skyshop-user');
    setToken('');
    setUser(null);
    setCart({});
    setAccountOpen(false);
    showNotice('You have signed out. Your saved server cart is still available when you sign in again.');
  }

  function startCheckout() {
    if (!cartItems.length) {
      showNotice('Add a product to your bag before checking out.');
      return;
    }
    if (!token || !user) {
      setCartOpen(false);
      setAuthMode('login');
      setAccountOpen(true);
      showNotice('Sign in or create an account to place your order.');
      return;
    }
    if (catalogSource !== 'api') {
      showNotice('The backend is unavailable. Start the server and reload products before checking out.');
      return;
    }
    setCheckoutForm((previous) => ({
      ...previous,
      name: previous.name || `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      email: previous.email || user.email || '',
      phone: previous.phone || user.phone || '',
    }));
    setCheckoutOpen(true);
  }

  async function handleCheckoutSubmit(event) {
    event.preventDefault();
    if (!cartItems.length) {
      showNotice('Your bag is empty.');
      setCheckoutOpen(false);
      return;
    }
    setCheckoutLoading(true);
    try {
      const payload = {
        customer: { name: checkoutForm.name.trim(), email: checkoutForm.email.trim(), phone: checkoutForm.phone.trim() },
        shippingAddress: {
          addressLine1: checkoutForm.addressLine1.trim(),
          addressLine2: checkoutForm.addressLine2.trim(),
          city: checkoutForm.city.trim(),
          province: checkoutForm.province.trim(),
          postalCode: checkoutForm.postalCode.trim(),
          country: checkoutForm.country.trim() || 'Philippines',
        },
        items: cartItems.map((item) => ({ productId: item._id, quantity: item.quantity })),
        paymentMethod: checkoutForm.paymentMethod,
        notes: checkoutForm.notes.trim(),
      };
      const result = await apiRequest('/orders', { method: 'POST', body: payload });
      setCart({});
      setCheckoutOpen(false);
      setCartOpen(false);
      await reloadProducts();
      showNotice(`Order placed successfully · ${String(result.data?._id || '').slice(-8).toUpperCase()}`);
    } catch (error) {
      showNotice(error.message || 'Checkout failed. Please review your details and try again.');
    } finally {
      setCheckoutLoading(false);
    }
  }

  return (
      <div className="app-shell">
          <header className="site-header">
              <button
                  className="mobile-menu icon-button"
                  onClick={() => setMobileMenu(!mobileMenu)}
                  aria-label="Toggle menu"
              >
                  <Menu size={21} />
              </button>
              <a className="brand" href="#top" aria-label="SkyShop home">
                  <span className="brand-mark">
                      <span></span>
                      <span></span>
                      <span></span>
                  </span>
                  <span>
                      skyshop<span className="brand-period">.</span>
                  </span>
              </a>
              <nav className={mobileMenu ? "main-nav nav-open" : "main-nav"}>
                  <a
                      className="active"
                      href="#shop"
                      onClick={() => setMobileMenu(false)}
                  >
                      Shop all
                  </a>
                  <a
                      href="#shop"
                      onClick={() => {
                          setCategory("Fashion");
                          setMobileMenu(false);
                      }}
                  >
                      Fashion
                  </a>
                  <a
                      href="#shop"
                      onClick={() => {
                          setCategory("Home");
                          setMobileMenu(false);
                      }}
                  >
                      Home & living
                  </a>
                  <a href="#story" onClick={() => setMobileMenu(false)}>
                      Our story
                  </a>
              </nav>
              <div className="header-actions">
                  <label className="header-search">
                      <Search size={17} />
                      <input
                          aria-label="Search products"
                          placeholder="Find your next fave..."
                          value={search}
                          onChange={(event) => {
                              setSearch(event.target.value);
                              if (event.target.value)
                                  document
                                      .getElementById("shop")
                                      ?.scrollIntoView({ behavior: "smooth" });
                          }}
                      />
                      <kbd>⌘ K</kbd>
                  </label>
                  <button
                      className="icon-button wishlist-top"
                      aria-label="Wishlist"
                      onClick={() =>
                          showNotice(
                              `${wishlist.length} item${wishlist.length === 1 ? "" : "s"} saved to your wishlist`,
                          )
                      }
                  >
                      <Heart size={20} />
                      {wishlist.length > 0 && (
                          <span className="tiny-count">{wishlist.length}</span>
                      )}
                  </button>
                  <button
                      className="account-button"
                      onClick={openAccount}
                      aria-label={
                          user
                              ? `Account: ${user.firstName}`
                              : "Sign in or create an account"
                      }
                  >
                      <UserRound size={17} />
                      <span>{user ? user.firstName : "Account"}</span>
                  </button>
                  <button
                      className="bag-button"
                      onClick={() => setCartOpen(true)}
                      aria-label={`Shopping bag, ${cartCount} items`}
                  >
                      <ShoppingBag size={18} />
                      <span>Bag</span>
                      <span className="bag-count">{cartCount}</span>
                  </button>
              </div>
          </header>

          <main id="top">
              <section className="hero-wrap">
                  <div className="hero-copy">
                      <div className="eyebrow">
                          <span className="eyebrow-line"></span> GOOD FINDS,
                          GOOD FEELS
                      </div>
                      <h1>
                          Little things.
                          <br />
                          <em>Lovely finds.</em>
                      </h1>
                      <p className="hero-description">
                          Thoughtful everyday essentials that bring a little
                          more joy to your every day. Go on, find your new
                          favorite.
                      </p>
                      <div className="hero-actions">
                          <button
                              className="primary-button"
                              onClick={goProducts}
                          >
                              Explore the collection <ArrowRight size={17} />
                          </button>
                          <div className="social-proof">
                              <div className="avatar-stack">
                                  <span>J</span>
                                  <span>M</span>
                                  <span>A</span>
                              </div>
                              <div>
                                  <div className="proof-stars">★★★★★</div>
                                  <small>Loved by 2,400+ happy shoppers</small>
                              </div>
                          </div>
                      </div>
                      <div className="hero-footnote">
                          <span className="footnote-icon">
                              <Truck size={16} />
                          </span>{" "}
                          Made for everyday. Picked with care.
                      </div>
                  </div>
                  <div className="hero-art">
                      <div className="hero-sun"></div>
                      <div className="hero-sticker sticker-top">
                          a little
                          <br />
                          something <span>♡</span>
                      </div>
                      <div className="hero-photo">
                          <img
                              className="hero-cloud-image"
                              src={localImage("Cloud")}
                              alt=""
                          />
                          <div className="photo-label">
                              <span className="photo-label-dot"></span> THE
                              EVERYDAY EDIT <span>01 / 04</span>
                          </div>
                      </div>
                      <div className="hero-sticker sticker-bottom">
                          <span className="sparkle-doodle">✳</span>
                          <span>
                              Good things
                              <br />
                              are here.
                          </span>
                      </div>
                      <div className="hero-orbit"></div>
                  </div>
              </section>
              <section className="benefit-strip">
                  <div>
                      <span className="benefit-icon">
                          <Truck size={18} />
                      </span>
                      <span>
                          <b>Free shipping</b>
                          <small>On orders ₱1,500+</small>
                      </span>
                  </div>
                  <div>
                      <span className="benefit-icon">
                          <ShieldCheck size={18} />
                      </span>
                      <span>
                          <b>Easy, secure checkout</b>
                          <small>Shop with peace of mind</small>
                      </span>
                  </div>
                  <div>
                      <span className="benefit-icon">
                          <Package size={18} />
                      </span>
                      <span>
                          <b>Packed with care</b>
                          <small>A little joy, delivered</small>
                      </span>
                  </div>
                  <div>
                      <span className="benefit-icon">
                          <Headphones size={18} />
                      </span>
                      <span>
                          <b>Here to help</b>
                          <small>Real people, kind answers</small>
                      </span>
                  </div>
              </section>

              <section className="shop-section" id="shop">
                  <div className="section-heading">
                      <div>
                          <div className="eyebrow">
                              <span className="eyebrow-line"></span> YOUR NEXT
                              FAVORITE
                          </div>
                          <h2>
                              Good things, <em>right this way.</em>
                          </h2>
                          <p>Little upgrades for your everyday routine.</p>
                      </div>
                      <a
                          className="text-link"
                          href="#shop"
                          onClick={() => {
                              setCategory("All");
                              setSearch("");
                          }}
                      >
                          See everything <ArrowRight size={16} />
                      </a>
                  </div>
                  <div className="shop-toolbar">
                      <div className="category-pills">
                          {categories.map((item) => (
                              <button
                                  key={item}
                                  className={
                                      category === item
                                          ? "category-pill selected"
                                          : "category-pill"
                                  }
                                  onClick={() => setCategory(item)}
                              >
                                  {item}
                              </button>
                          ))}
                      </div>
                      <label className="sort-select">
                          <SlidersHorizontal size={15} />
                          <select
                              value={sort}
                              onChange={(event) => setSort(event.target.value)}
                              aria-label="Sort products"
                          >
                              <option value="featured">Featured</option>
                              <option value="low">Price: low to high</option>
                              <option value="high">Price: high to low</option>
                              <option value="rating">Top rated</option>
                          </select>
                          <ChevronDown size={14} />
                      </label>
                  </div>
                  {catalogLoading && (
                      <div className="api-loading">
                          <LoaderCircle size={17} className="spin-icon" />{" "}
                          Loading products from SkyShop server…
                      </div>
                  )}
                  {catalogSource === "error" && !catalogLoading && (
                      <div className="api-fallback" role="alert">
                          Unable to load products from the server.
                          <button onClick={reloadProducts}>Try again</button>
                          <small>{catalogError}</small>
                      </div>
                  )}
                  {catalogSource === "api"
                      ? "Server connected"
                      : catalogSource === "loading"
                        ? "Connecting to server…"
                        : "Server offline"}
                  <div className="product-grid">
                      {visibleProducts.map((product) => (
                          <article className="product-card" key={product._id}>
                              <div
                                  className="product-image-wrap"
                                  style={{
                                      background: product.bg || "#e2efff",
                                  }}
                              >
                                  <img
                                      src={product.image || placeholderImage}
                                      alt={product.name}
                                      loading="lazy"
                                  />
                                  <div className="product-tags">
                                      {product.tag && (
                                          <span className="product-tag">
                                              {product.tag}
                                          </span>
                                      )}
                                      {product.oldPrice && (
                                          <span className="sale-tag">SALE</span>
                                      )}
                                  </div>
                                  <button
                                      className={
                                          wishlist.includes(product._id)
                                              ? "wish-button wished"
                                              : "wish-button"
                                      }
                                      onClick={() => toggleWish(product._id)}
                                      aria-label={
                                          wishlist.includes(product._id)
                                              ? "Remove from wishlist"
                                              : "Add to wishlist"
                                      }
                                  >
                                      <Heart
                                          size={17}
                                          fill={
                                              wishlist.includes(product._id)
                                                  ? "currentColor"
                                                  : "none"
                                          }
                                      />
                                  </button>
                                  <button
                                      className="quick-add"
                                      onClick={() => addToCart(product)}
                                      disabled={product.stock <= 0}
                                  >
                                      <Plus size={16} />{" "}
                                      {product.stock <= 0
                                          ? "Out of stock"
                                          : "Quick add"}
                                  </button>
                              </div>
                              <div className="product-details">
                                  <div className="product-category">
                                      {product.category}
                                  </div>
                                  <div className="product-title-row">
                                      <h3>{product.name}</h3>
                                      <div className="rating">
                                          <Star size={12} fill="currentColor" />{" "}
                                          {product.rating || "4.8"}
                                      </div>
                                  </div>
                                  <p className="product-description">
                                      {product.description}
                                  </p>
                                  <div className="price-row">
                                      <span className="price">
                                          {peso(product.price)}
                                      </span>
                                      {product.oldPrice && (
                                          <span className="old-price">
                                              {peso(product.oldPrice)}
                                          </span>
                                      )}
                                  </div>
                                  <small className="stock-note">
                                      {product.stock > 0
                                          ? `${product.stock} in stock`
                                          : "Currently unavailable"}
                                  </small>
                              </div>
                          </article>
                      ))}
                  </div>
                  {!catalogLoading &&
                      visibleProducts.length === 0 &&
                      catalogSource !== "api" && (
                          <div className="empty-state">
                              <span>☁</span>
                              <h3>No finds just yet</h3>
                              <p>
                                  Try another search or category. Your next
                                  favorite is out there.
                              </p>
                              <button
                                  className="primary-button"
                                  onClick={() => {
                                      setSearch("");
                                      setCategory("All");
                                  }}
                              >
                                  Clear filters <ArrowRight size={16} />
                              </button>
                          </div>
                      )}
                  {!catalogLoading &&
                      catalogSource === "api" &&
                      products.length > 0 &&
                      visibleProducts.length === 0 && (
                          <div className="empty-state">
                              <span>☁</span>
                              <h3>No matching finds</h3>
                              <p>Try another search or category.</p>
                              <button
                                  className="primary-button"
                                  onClick={() => {
                                      setSearch("");
                                      setCategory("All");
                                  }}
                              >
                                  Clear filters <ArrowRight size={16} />
                              </button>
                          </div>
                      )}
                  <div className="collection-note">
                      <span className="note-star">✳</span>
                      <span>
                          <b>Good taste. No guesswork.</b>
                          <small>
                              Small-batch finds and everyday favorites, all in
                              one happy place.
                          </small>
                      </span>
                      <button
                          onClick={() =>
                              showNotice("You’re already in the right place ✨")
                          }
                      >
                          A little more about us <ArrowRight size={15} />
                      </button>
                  </div>
              </section>
              <section className="story-section" id="story">
                  <div className="story-visual">
                      <span className="story-bubble">
                          picked
                          <br />
                          with ♡
                      </span>
                  </div>
                  <div className="story-copy">
                      <div className="eyebrow">
                          <span className="eyebrow-line"></span> A NOTE FROM US
                      </div>
                      <h2>
                          Everyday can be
                          <br />
                          <em>a little extraordinary.</em>
                      </h2>
                      <p>
                          We believe the little things make a big difference.
                          That's why we bring together useful, lovely, and
                          thoughtfully chosen finds that fit right into your
                          life.
                      </p>
                      <p>
                          No overthinking. No fuss. Just things you'll be happy
                          to bring home.
                      </p>
                      <button
                          className="secondary-button"
                          onClick={() =>
                              showNotice(
                                  "Thanks for stopping by SkyShop. We’re happy you’re here!",
                              )
                          }
                      >
                          Get to know SkyShop <ArrowRight size={16} />
                      </button>
                  </div>
              </section>
              <section className="newsletter">
                  <div className="newsletter-spark">✳</div>
                  <div>
                      <div className="eyebrow">A LITTLE NOTE IN YOUR INBOX</div>
                      <h2>
                          Good things come to <em>those who subscribe.</em>
                      </h2>
                      <p>
                          Fresh finds, little perks, and the occasional happy
                          surprise.
                      </p>
                  </div>
                  <form
                      onSubmit={(event) => {
                          event.preventDefault();
                          showNotice(
                              "Newsletter subscription is a frontend demo for now.",
                          );
                          event.currentTarget.reset();
                      }}
                  >
                      <input
                          type="email"
                          placeholder="Your email address"
                          aria-label="Email address"
                          required
                      />
                      <button type="submit" aria-label="Subscribe">
                          <ArrowRight size={19} />
                      </button>
                  </form>
              </section>
          </main>
          <footer className="site-footer">
              <a className="brand" href="#top">
                  <span className="brand-mark">
                      <span></span>
                      <span></span>
                      <span></span>
                  </span>
                  <span>
                      skyshop<span className="brand-period">.</span>
                  </span>
              </a>
              <span>Little things, lovely finds. © 2026 SkyShop.</span>
              <div>
                  <a href="#shop">Shop</a>
                  <a href="#story">Our story</a>
                  <a href="mailto:hello@skyshop.example">Contact</a>
              </div>
          </footer>

          {notice && (
              <div className="toast" role="status">
                  <span className="toast-check">
                      <Check size={15} />
                  </span>
                  {notice}
                  <button
                      onClick={() => setNotice("")}
                      aria-label="Dismiss notification"
                  >
                      <X size={15} />
                  </button>
              </div>
          )}

          {accountOpen && (
              <div
                  className="modal-backdrop"
                  onClick={() => setAccountOpen(false)}
              >
                  <section
                      className="form-modal account-modal"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="account-title"
                      onClick={(event) => event.stopPropagation()}
                  >
                      <div className="modal-heading">
                          <div>
                              <span className="eyebrow">
                                  YOUR SKYSHOP ACCOUNT
                              </span>
                              <h2 id="account-title">
                                  {user
                                      ? `Hello, ${user.firstName}!`
                                      : authMode === "login"
                                        ? "Welcome back."
                                        : "Join the good finds."}
                              </h2>
                              <p>
                                  {user
                                      ? "Your account is connected to the SkyShop server."
                                      : authMode === "login"
                                        ? "Sign in to sync your bag and place an order."
                                        : "Create an account to save your cart and check out."}
                              </p>
                          </div>
                          <button
                              className="icon-button"
                              onClick={() => setAccountOpen(false)}
                              aria-label="Close account dialog"
                          >
                              <X size={20} />
                          </button>
                      </div>
                      {user ? (
                          <div className="signed-in-panel">
                              <div className="signed-user-icon">
                                  <UserRound size={25} />
                              </div>
                              <strong>
                                  {user.firstName} {user.lastName}
                              </strong>
                              <span>{user.email}</span>
                              <small>Role: {user.role}</small>
                              <button
                                  className="secondary-button"
                                  onClick={signOut}
                              >
                                  <LogOut size={16} /> Sign out
                              </button>
                          </div>
                      ) : (
                          <form
                              className="modal-form"
                              onSubmit={handleAuthSubmit}
                          >
                              {authMode === "register" && (
                                  <div className="form-grid two-columns">
                                      <label>
                                          First name
                                          <input
                                              value={authForm.firstName}
                                              onChange={(event) =>
                                                  setAuthForm({
                                                      ...authForm,
                                                      firstName:
                                                          event.target.value,
                                                  })
                                              }
                                              autoComplete="given-name"
                                              required
                                              maxLength={80}
                                          />
                                      </label>
                                      <label>
                                          Last name
                                          <input
                                              value={authForm.lastName}
                                              onChange={(event) =>
                                                  setAuthForm({
                                                      ...authForm,
                                                      lastName:
                                                          event.target.value,
                                                  })
                                              }
                                              autoComplete="family-name"
                                              required
                                              maxLength={80}
                                          />
                                      </label>
                                  </div>
                              )}
                              <label>
                                  Email address
                                  <input
                                      type="email"
                                      value={authForm.email}
                                      onChange={(event) =>
                                          setAuthForm({
                                              ...authForm,
                                              email: event.target.value,
                                          })
                                      }
                                      autoComplete="email"
                                      required
                                      maxLength={254}
                                  />
                              </label>
                              {authMode === "register" && (
                                  <label>
                                      Phone number{" "}
                                      <span className="optional-label">
                                          (optional)
                                      </span>
                                      <input
                                          value={authForm.phone}
                                          onChange={(event) =>
                                              setAuthForm({
                                                  ...authForm,
                                                  phone: event.target.value,
                                              })
                                          }
                                          autoComplete="tel"
                                          maxLength={30}
                                      />
                                  </label>
                              )}
                              <label>
                                  Password
                                  <input
                                      type="password"
                                      value={authForm.password}
                                      onChange={(event) =>
                                          setAuthForm({
                                              ...authForm,
                                              password: event.target.value,
                                          })
                                      }
                                      autoComplete={
                                          authMode === "login"
                                              ? "current-password"
                                              : "new-password"
                                      }
                                      minLength={8}
                                      maxLength={128}
                                      required
                                  />
                                  <small>At least 8 characters.</small>
                              </label>
                              <button
                                  className="primary-button modal-submit"
                                  type="submit"
                                  disabled={authLoading}
                              >
                                  {authLoading ? (
                                      <LoaderCircle
                                          className="spin-icon"
                                          size={17}
                                      />
                                  ) : (
                                      <LockKeyhole size={16} />
                                  )}{" "}
                                  {authLoading
                                      ? "Please wait…"
                                      : authMode === "login"
                                        ? "Sign in"
                                        : "Create account"}
                              </button>
                              <p className="auth-toggle">
                                  {authMode === "login"
                                      ? "New to SkyShop?"
                                      : "Already have an account?"}{" "}
                                  <button
                                      type="button"
                                      onClick={() =>
                                          setAuthMode(
                                              authMode === "login"
                                                  ? "register"
                                                  : "login",
                                          )
                                      }
                                  >
                                      {authMode === "login"
                                          ? "Create an account"
                                          : "Sign in"}
                                  </button>
                              </p>
                              {catalogSource !== "api" && (
                                  <p className="modal-warning">
                                      The backend is currently unavailable.
                                      Start the server before signing in.
                                  </p>
                              )}
                          </form>
                      )}
                  </section>
              </div>
          )}

          {checkoutOpen && (
              <div
                  className="modal-backdrop checkout-backdrop"
                  onClick={() => !checkoutLoading && setCheckoutOpen(false)}
              >
                  <section
                      className="form-modal checkout-modal"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="checkout-title"
                      onClick={(event) => event.stopPropagation()}
                  >
                      <div className="modal-heading">
                          <div>
                              <span className="eyebrow">ALMOST YOURS</span>
                              <h2 id="checkout-title">Delivery details</h2>
                              <p>
                                  Order total is calculated and inventory is
                                  checked by the server.
                              </p>
                          </div>
                          <button
                              className="icon-button"
                              onClick={() => setCheckoutOpen(false)}
                              disabled={checkoutLoading}
                              aria-label="Close checkout"
                          >
                              <X size={20} />
                          </button>
                      </div>
                      <form
                          className="modal-form"
                          onSubmit={handleCheckoutSubmit}
                      >
                          <div className="form-grid two-columns">
                              <label>
                                  Full name
                                  <input
                                      value={checkoutForm.name}
                                      onChange={(event) =>
                                          setCheckoutForm({
                                              ...checkoutForm,
                                              name: event.target.value,
                                          })
                                      }
                                      required
                                      maxLength={160}
                                      autoComplete="name"
                                  />
                              </label>
                              <label>
                                  Email
                                  <input
                                      type="email"
                                      value={checkoutForm.email}
                                      onChange={(event) =>
                                          setCheckoutForm({
                                              ...checkoutForm,
                                              email: event.target.value,
                                          })
                                      }
                                      required
                                      maxLength={254}
                                      autoComplete="email"
                                  />
                              </label>
                          </div>
                          <label>
                              Phone number
                              <input
                                  value={checkoutForm.phone}
                                  onChange={(event) =>
                                      setCheckoutForm({
                                          ...checkoutForm,
                                          phone: event.target.value,
                                      })
                                  }
                                  maxLength={30}
                                  autoComplete="tel"
                              />
                          </label>
                          <label>
                              Address line 1
                              <input
                                  value={checkoutForm.addressLine1}
                                  onChange={(event) =>
                                      setCheckoutForm({
                                          ...checkoutForm,
                                          addressLine1: event.target.value,
                                      })
                                  }
                                  required
                                  maxLength={200}
                                  autoComplete="address-line1"
                              />
                          </label>
                          <label>
                              Address line 2{" "}
                              <span className="optional-label">(optional)</span>
                              <input
                                  value={checkoutForm.addressLine2}
                                  onChange={(event) =>
                                      setCheckoutForm({
                                          ...checkoutForm,
                                          addressLine2: event.target.value,
                                      })
                                  }
                                  maxLength={200}
                                  autoComplete="address-line2"
                              />
                          </label>
                          <div className="form-grid two-columns">
                              <label>
                                  City
                                  <input
                                      value={checkoutForm.city}
                                      onChange={(event) =>
                                          setCheckoutForm({
                                              ...checkoutForm,
                                              city: event.target.value,
                                          })
                                      }
                                      required
                                      maxLength={100}
                                      autoComplete="address-level2"
                                  />
                              </label>
                              <label>
                                  Province / region
                                  <input
                                      value={checkoutForm.province}
                                      onChange={(event) =>
                                          setCheckoutForm({
                                              ...checkoutForm,
                                              province: event.target.value,
                                          })
                                      }
                                      required
                                      maxLength={100}
                                      autoComplete="address-level1"
                                  />
                              </label>
                          </div>
                          <div className="form-grid two-columns">
                              <label>
                                  Postal code
                                  <input
                                      value={checkoutForm.postalCode}
                                      onChange={(event) =>
                                          setCheckoutForm({
                                              ...checkoutForm,
                                              postalCode: event.target.value,
                                          })
                                      }
                                      required
                                      maxLength={20}
                                      autoComplete="postal-code"
                                  />
                              </label>
                              <label>
                                  Country
                                  <input
                                      value={checkoutForm.country}
                                      onChange={(event) =>
                                          setCheckoutForm({
                                              ...checkoutForm,
                                              country: event.target.value,
                                          })
                                      }
                                      required
                                      maxLength={100}
                                      autoComplete="country-name"
                                  />
                              </label>
                          </div>
                          <label>
                              Payment method
                              <select
                                  value={checkoutForm.paymentMethod}
                                  onChange={(event) =>
                                      setCheckoutForm({
                                          ...checkoutForm,
                                          paymentMethod: event.target.value,
                                      })
                                  }
                              >
                                  <option value="cash_on_delivery">
                                      Cash on delivery
                                  </option>
                                  <option value="bank_transfer">
                                      Bank transfer
                                  </option>
                                  <option value="e_wallet">E-wallet</option>
                              </select>
                          </label>
                          <label>
                              Order notes{" "}
                              <span className="optional-label">(optional)</span>
                              <textarea
                                  value={checkoutForm.notes}
                                  onChange={(event) =>
                                      setCheckoutForm({
                                          ...checkoutForm,
                                          notes: event.target.value,
                                      })
                                  }
                                  rows={2}
                                  maxLength={1000}
                              />
                          </label>
                          <div className="checkout-summary">
                              <span>{cartCount} item(s) · Subtotal</span>
                              <strong>{peso(subtotal)}</strong>
                              <small>
                                  {subtotal >= 1500
                                      ? "Free shipping"
                                      : "₱100 shipping fee applies at checkout"}
                              </small>
                          </div>
                          <button
                              className="primary-button modal-submit"
                              type="submit"
                              disabled={checkoutLoading}
                          >
                              {checkoutLoading ? (
                                  <LoaderCircle
                                      className="spin-icon"
                                      size={17}
                                  />
                              ) : (
                                  <ShoppingBag size={16} />
                              )}{" "}
                              {checkoutLoading
                                  ? "Placing order…"
                                  : "Place order"}
                          </button>
                      </form>
                  </section>
              </div>
          )}

          {cartOpen && (
              <div
                  className="drawer-backdrop"
                  onClick={() => setCartOpen(false)}
              >
                  <aside
                      className="cart-drawer"
                      onClick={(event) => event.stopPropagation()}
                  >
                      <div className="drawer-header">
                          <div>
                              <span className="eyebrow">YOUR LITTLE FINDS</span>
                              <h2>
                                  Your bag <span>({cartCount})</span>
                              </h2>
                          </div>
                          <button
                              className="icon-button"
                              onClick={() => setCartOpen(false)}
                              aria-label="Close cart"
                          >
                              <X size={21} />
                          </button>
                      </div>
                      {cartItems.length === 0 ? (
                          <div className="cart-empty">
                              <div className="empty-bag">
                                  <ShoppingBag size={29} />
                              </div>
                              <h3>Your bag is taking a little nap.</h3>
                              <p>Find something lovely to bring home.</p>
                              <button
                                  className="primary-button"
                                  onClick={() => {
                                      setCartOpen(false);
                                      goProducts();
                                  }}
                              >
                                  Explore the collection{" "}
                                  <ArrowRight size={16} />
                              </button>
                          </div>
                      ) : (
                          <>
                              <div className="cart-items">
                                  {cartItems.map((item) => (
                                      <div className="cart-item" key={item._id}>
                                          <img
                                              src={
                                                  item.image || placeholderImage
                                              }
                                              alt={item.name}
                                          />
                                          <div className="cart-item-info">
                                              <h3>{item.name}</h3>
                                              <small>
                                                  {item.category} · {item.stock}{" "}
                                                  in stock
                                              </small>
                                              <b>{peso(item.price)}</b>
                                              <div className="quantity-control">
                                                  <button
                                                      onClick={() =>
                                                          changeQty(
                                                              item._id,
                                                              -1,
                                                          )
                                                      }
                                                      aria-label="Decrease quantity"
                                                  >
                                                      <Minus size={13} />
                                                  </button>
                                                  <span>{item.quantity}</span>
                                                  <button
                                                      onClick={() =>
                                                          changeQty(item._id, 1)
                                                      }
                                                      aria-label="Increase quantity"
                                                      disabled={
                                                          item.quantity >=
                                                          item.stock
                                                      }
                                                  >
                                                      <Plus size={13} />
                                                  </button>
                                              </div>
                                          </div>
                                          <button
                                              className="remove-item"
                                              onClick={() =>
                                                  setCartQuantity(item._id, 0)
                                              }
                                              aria-label={`Remove ${item.name}`}
                                          >
                                              <X size={15} />
                                          </button>
                                      </div>
                                  ))}
                              </div>
                              <div className="cart-footer">
                                  <div className="shipping-progress">
                                      <Truck size={16} />
                                      {subtotal >= 1500
                                          ? "You unlocked free shipping!"
                                          : `You’re ${peso(1500 - subtotal)} away from free shipping`}
                                      <div className="progress-track">
                                          <span
                                              style={{
                                                  width: `${Math.min(100, (subtotal / 1500) * 100)}%`,
                                              }}
                                          />
                                      </div>
                                  </div>
                                  <div className="subtotal-row">
                                      <span>Subtotal</span>
                                      <b>{peso(subtotal)}</b>
                                  </div>
                                  <small className="checkout-note">
                                      Shipping fee is confirmed by the server
                                      when you place your order.
                                  </small>
                                  <button
                                      className="primary-button checkout-button"
                                      onClick={startCheckout}
                                  >
                                      Continue to checkout{" "}
                                      <ArrowRight size={17} />
                                  </button>
                              </div>
                          </>
                      )}
                  </aside>
              </div>
          )}

          <div className="connection-indicator" title={`API: ${API_BASE_URL}`}>
              <span
                  className={`status-dot ${catalogSource === "api" ? "connected" : ""}`}
              ></span>
              {catalogSource === "api"
                  ? "Server connected"
                  : catalogSource === "loading"
                    ? "Connecting to server…"
                    : "Demo mode · server offline"}
          </div>
      </div>
  );
}

export default App;
