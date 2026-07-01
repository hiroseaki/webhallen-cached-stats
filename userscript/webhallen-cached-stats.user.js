// ==UserScript==
// @name         Webhallen cached stats
// @namespace    Webhallen
// @version      1.1.0
// @description  Adds a faster statistics page with persistent local order cache and incremental sync.
// @author       Linus, based on the code from Schanihbg/webhallen-userscript
// @match        https://www.webhallen.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=webhallen.com
// @homepageURL  https://github.com/hiroseaki/webhallen-cached-stats
// @updateURL    https://raw.githubusercontent.com/hiroseaki/webhallen-cached-stats/main/userscript/webhallen-cached-stats.user.js
// @downloadURL  https://raw.githubusercontent.com/hiroseaki/webhallen-cached-stats/main/userscript/webhallen-cached-stats.user.js
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        window.onurlchange
// ==/UserScript==

(() => {
  "use strict";

  const DB_NAME = "webhallen-cached-stats";
  const DB_VERSION = 2;
  const ORDER_STORE = "orders";
  const REVIEW_STORE = "reviews";
  const META_STORE = "meta";

  let cachedMe = null;
  let stylesInjected = false;
  let chartsStylesInjected = false;
  const auxiliaryCache = new Map();
  const syncingUsers = new Set();

  function apiUrl(path) {
    return new URL(path, "https://www.webhallen.com").toString();
  }

  async function fetchApi(path, params = {}) {
    const url = new URL(apiUrl(path));
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Webhallen API svarade ${response.status} for ${url.pathname}`);
    }

    return response.json();
  }

  async function fetchMe() {
    if (cachedMe) return cachedMe;
    const data = await fetchApi("/api/me");
    cachedMe = data.user || null;
    return cachedMe;
  }

  async function fetchAchievements(userId) {
    const cacheKey = `achievements:${userId}`;
    if (auxiliaryCache.has(cacheKey)) return auxiliaryCache.get(cacheKey);
    const data = await fetchApi(`/api/user/${encodeURIComponent(userId)}/achievements`);
    const achievements = Array.isArray(data.achievements) ? data.achievements : [];
    auxiliaryCache.set(cacheKey, achievements);
    return achievements;
  }

  async function fetchSupplyDrops() {
    const cacheKey = "supply-drops";
    if (auxiliaryCache.has(cacheKey)) return auxiliaryCache.get(cacheKey);
    const data = await fetchApi("/api/supply-drop/");
    const drops = Array.isArray(data.drops) ? data.drops : [];
    auxiliaryCache.set(cacheKey, drops);
    return drops;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ORDER_STORE)) {
          const orders = db.createObjectStore(ORDER_STORE, { keyPath: "cacheKey" });
          orders.createIndex("userId", "userId", { unique: false });
          orders.createIndex("userOrder", ["userId", "orderDate"], { unique: false });
        }
        if (!db.objectStoreNames.contains(REVIEW_STORE)) {
          const reviews = db.createObjectStore(REVIEW_STORE, { keyPath: "cacheKey" });
          reviews.createIndex("userId", "userId", { unique: false });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async function getMeta(userId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const request = tx.objectStore(META_STORE).get(String(userId));
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function setMeta(userId, patch) {
    const db = await openDb();
    const current = (await getMeta(userId)) || { key: String(userId) };
    const tx = db.transaction(META_STORE, "readwrite");
    tx.objectStore(META_STORE).put({ ...current, ...patch, key: String(userId) });
    await txDone(tx);
  }

  async function getCachedOrders(userId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(ORDER_STORE, "readonly");
      const index = tx.objectStore(ORDER_STORE).index("userId");
      const request = index.getAll(String(userId));
      request.onsuccess = () => {
        const orders = (request.result || [])
          .map((row) => row.order)
          .sort((a, b) => Number(b.orderDate || 0) - Number(a.orderDate || 0));
        resolve(orders);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function cachedOrderIds(userId) {
    const orders = await getCachedOrders(userId);
    return new Set(orders.map((order) => String(order.id)));
  }

  async function saveOrders(userId, orders) {
    if (!orders.length) return;
    const db = await openDb();
    const tx = db.transaction(ORDER_STORE, "readwrite");
    const store = tx.objectStore(ORDER_STORE);
    for (const order of orders) {
      if (!order || !order.id || order.error) continue;
      store.put({
        cacheKey: `${userId}:${order.id}`,
        userId: String(userId),
        orderDate: Number(order.orderDate || 0),
        order,
      });
    }
    await txDone(tx);
  }

  async function clearOrderCache(userId) {
    const db = await openDb();
    const orders = await getCachedOrders(userId);
    const tx = db.transaction([ORDER_STORE, META_STORE], "readwrite");
    const orderStore = tx.objectStore(ORDER_STORE);
    for (const order of orders) {
      orderStore.delete(`${userId}:${order.id}`);
    }
    tx.objectStore(META_STORE).delete(String(userId));
    await txDone(tx);
  }

  async function getCachedReviewRows(userId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REVIEW_STORE, "readonly");
      const index = tx.objectStore(REVIEW_STORE).index("userId");
      const request = index.getAll(String(userId));
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveReviewRows(userId, rows) {
    if (!rows.length) return;
    const db = await openDb();
    const tx = db.transaction(REVIEW_STORE, "readwrite");
    const store = tx.objectStore(REVIEW_STORE);
    for (const row of rows) {
      store.put({
        ...row,
        cacheKey: `${userId}:${row.product}`,
        userId: String(userId),
        checkedAt: Date.now(),
      });
    }
    await txDone(tx);
  }

  function purchasedProductsFromOrders(orders) {
    const products = new Map();
    orderRows(orders).forEach((row) => {
      const product = row.product || {};
      const id = product.id || row.productId || row.id;
      if (!id || products.has(String(id))) return;
      products.set(String(id), {
        id: String(id),
        name: product.name || row.name || `Produkt ${id}`,
      });
    });
    return [...products.values()];
  }

  async function fetchProductReviews(productId) {
    const reviews = [];
    let page = 1;
    while (true) {
      const data = await fetchApi(`/api/reviews?products[0]=${encodeURIComponent(productId)}&sortby=latest`, { page });
      const pageReviews = Array.isArray(data.reviews) ? data.reviews : [];
      if (!pageReviews.length) break;
      reviews.push(...pageReviews);
      page++;
    }
    return reviews;
  }

  async function syncReviews(userId, products, { onProgress = () => {} } = {}) {
    const syncedRows = [];
    for (let index = 0; index < products.length; index++) {
      const product = products[index];
      onProgress({ current: index, total: products.length, product });
      const reviews = await fetchProductReviews(product.id);
      const userReview = reviews.find((review) => {
        if (review.isAnonymous) return false;
        return String(review.user?.id || "") === String(userId);
      }) || null;
      const row = {
        product: product.id,
        productName: product.name,
        review: userReview,
      };
      syncedRows.push(row);
      await saveReviewRows(userId, [row]);
    }
    onProgress({ current: products.length, total: products.length, product: null });
    await setMeta(`${userId}:reviews`, {
      lastReviewSyncAt: Date.now(),
      lastReviewProductCount: products.length,
      lastReviewHitCount: syncedRows.filter((row) => row.review).length,
    });
    return {
      rows: await getCachedReviewRows(userId),
      meta: await getMeta(`${userId}:reviews`),
    };
  }

  async function fetchOrderPage(userId, page) {
    const data = await fetchApi(`/api/order/user/${encodeURIComponent(userId)}?filters[history]=true&sort=orderStatus`, { page });
    return Array.isArray(data.orders) ? data.orders.filter((order) => !order.error) : [];
  }

  async function syncOrders(userId, { full = false, onProgress = () => {} } = {}) {
    const meta = await getMeta(userId);
    const cacheWasPreviouslyCompleted = meta?.fullCacheComplete === true || meta?.lastSyncMode === "full";
    const canStopAtKnownOrder = !full && cacheWasPreviouslyCompleted;
    const knownIds = canStopAtKnownOrder ? await cachedOrderIds(userId) : new Set();
    const fetched = [];
    let page = 1;
    let reachedKnownOrder = false;
    let reachedEmptyPage = false;

    while (!reachedKnownOrder) {
      onProgress({ page, fetched: fetched.length, done: false, canStopAtKnownOrder });
      const pageOrders = await fetchOrderPage(userId, page);
      if (!pageOrders.length) {
        reachedEmptyPage = true;
        break;
      }

      for (const order of pageOrders) {
        if (canStopAtKnownOrder && knownIds.has(String(order.id))) {
          reachedKnownOrder = true;
          break;
        }
        fetched.push(order);
      }

      page++;
    }

    await saveOrders(userId, fetched);
    await setMeta(userId, {
      lastSyncAt: Date.now(),
      lastSyncMode: full ? "full" : "incremental",
      lastFetchedOrders: fetched.length,
      fullCacheComplete: reachedEmptyPage || cacheWasPreviouslyCompleted,
    });

    return {
      fetched: fetched.length,
      reachedKnownOrder,
      reachedEmptyPage,
      orders: await getCachedOrders(userId),
      meta: await getMeta(userId),
    };
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return "Aldrig";
    return new Intl.DateTimeFormat("sv-SE", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  }

  function formatDate(timestamp) {
    if (!timestamp) return "";
    return new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(Number(timestamp) * 1000));
  }

  function timeAgo(unixTimestamp) {
    const now = Math.floor(Date.now() / 1000);
    const secondsAgo = now - Number(unixTimestamp || 0);
    const timeUnits = [
      { singular: "år", plural: "år", seconds: 365 * 24 * 60 * 60 },
      { singular: "månad", plural: "månader", seconds: 30 * 24 * 60 * 60 },
      { singular: "dag", plural: "dagar", seconds: 24 * 60 * 60 },
      { singular: "timma", plural: "timmar", seconds: 60 * 60 },
      { singular: "minut", plural: "minuter", seconds: 60 },
    ];
    for (const { singular, plural, seconds } of timeUnits) {
      const count = Math.floor(secondsAgo / seconds);
      if (count >= 1) return count === 1 ? `1 ${singular} sedan` : `${count} ${plural} sedan`;
    }
    return "Just nu";
  }

  function unixTimestampToLocale(unixTimestamp) {
    if (!unixTimestamp) return "";
    return new Intl.DateTimeFormat(navigator.language || "sv-SE", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      timeZoneName: "short",
    }).format(new Date(Number(unixTimestamp) * 1000));
  }

  function orderRows(orders) {
    return orders.flatMap((order) => Array.isArray(order.rows) ? order.rows : []);
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  }

  function csvNumber(value) {
    if (value === null || value === undefined || value === "") return "";
    const number = Number(value);
    return Number.isNaN(number) ? String(value) : String(number).replace(".", ",");
  }

  function getPathValue(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
  }

  function firstValue(object, paths) {
    for (const path of paths) {
      const value = getPathValue(object, path);
      if (value !== null && value !== undefined && value !== "") return value;
    }
    return "";
  }

  function numberValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(String(value).replace(/\s/g, "").replace(",", "."));
    return Number.isNaN(number) ? null : number;
  }

  function getOrderRowPrices(row) {
    const quantity = Number(row.quantity || row.qty || 1) || 1;
    let totalPrice = numberValue(firstValue(row, [
      "totalPrice",
      "rowTotal",
      "lineTotal",
      "rowSum",
      "priceTotal",
      "amountTotal",
      "lineSum",
      "totalInclVat",
    ]));
    let unitPrice = numberValue(firstValue(row, [
      "unitPrice",
      "unitPriceInclVat",
      "unitPriceIncVat",
      "priceInclVat",
      "priceIncVat",
      "priceWithVat",
      "sellPrice",
      "salePrice",
      "productPrice",
      "rowPrice",
      "price",
    ]));

    if (unitPrice === null && totalPrice !== null) unitPrice = totalPrice / quantity;
    if (totalPrice === null && unitPrice !== null) totalPrice = unitPrice * quantity;

    return {
      quantity,
      unitPrice: unitPrice ?? "",
      totalPrice: totalPrice ?? "",
    };
  }

  function orderExportRows(orders) {
    return orders.flatMap((order) => {
      const rows = Array.isArray(order.rows) ? order.rows : [];
      return rows.map((row) => {
        const product = row.product || {};
        const categories = String(product.categoryTree || "").split("/");
        const prices = getOrderRowPrices(row);
        return {
          orderDate: formatDate(order.orderDate),
          sentDate: formatDate(order.sentDate),
          orderNumber: order.id || "",
          store: order.store?.name || "",
          articleNumber: product.id || row.productId || row.id || "",
          productName: product.name || row.name || "",
          quantity: prices.quantity,
          price: prices.unitPrice,
          category: categories[0] || "",
          subcategory: categories[1] || "",
          categoryTree: product.categoryTree || "",
        };
      });
    });
  }

  function exportOrdersCsv(orders, userId) {
    const columns = [
      ["Beställningsdatum", "orderDate"],
      ["Skickat datum", "sentDate"],
      ["Ordernummer", "orderNumber"],
      ["Butik", "store"],
      ["Artikelnummer", "articleNumber"],
      ["Produktnamn", "productName"],
      ["Antal", "quantity"],
      ["Produktpris", "price"],
      ["Huvudkategori", "category"],
      ["Underkategori", "subcategory"],
      ["Kategoriträd", "categoryTree"],
    ];
    const numericKeys = new Set(["quantity", "price"]);
    const rows = orderExportRows(orders);
    const csvRows = [
      columns.map(([label]) => csvEscape(label)).join(";"),
      ...rows.map((row) => columns.map(([, key]) => {
        const value = numericKeys.has(key) ? csvNumber(row[key]) : row[key];
        return csvEscape(value);
      }).join(";")),
    ];
    const blob = new Blob([`\uFEFF${csvRows.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const link = el("a", {
      href: url,
      download: `webhallen-orders-${userId}-${today}.csv`,
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return rows.length;
  }

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "Maj", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"];

  function findCategoriesByPeriod(orders, beginDate = "1999-01-01", endDate = new Date()) {
    const catStartDate = Date.parse(beginDate);
    const catEndDate = endDate instanceof Date ? endDate.valueOf() : Date.parse(endDate);
    const unsortedCategories = {};

    orders.filter((order) => {
      const orderDate = new Date(Number(order.orderDate || 0) * 1000);
      return orderDate.valueOf() >= catStartDate && orderDate.valueOf() <= catEndDate;
    }).forEach((order) => {
      (order.rows || []).forEach((item) => {
        const categories = String(item.product?.categoryTree || "Okänd").split("/");
        const topLevel = categories[0] || "Okänd";
        const subcategory = categories.length > 1 ? categories[1] : null;
        const categoryString = topLevel + (subcategory !== null ? `/${subcategory}` : "");
        unsortedCategories[categoryString] = (unsortedCategories[categoryString] || 0) + 1;
      });
    });

    const sortedCategories = {};
    Object.keys(unsortedCategories).sort().forEach((key) => {
      sortedCategories[key] = unsortedCategories[key];
    });
    return sortedCategories;
  }

  function getExperienceStats(user, orders, achievements, supplyDrops) {
    const output = { purchases: 0, bonusXP: 0, achievements: 0, supplyDrops: 0, other: 0, total: 0 };
    orders.forEach((order) => {
      output.purchases += Number(order.totalSum || 0);
      (order.userExperiencePointBoosts || []).forEach((boost) => {
        output.bonusXP += Number(boost.experiencePoints || 0);
      });
    });
    achievements.filter((item) => Number(item.achievedPercentage || 0) >= 1).forEach((achievement) => {
      output.achievements += Number(achievement.experiencePoints || 0);
    });
    supplyDrops.forEach((drop) => {
      const xpValue = parseInt(String(drop.item?.description || "").replace("XP", "").trim(), 10);
      if (!Number.isNaN(xpValue)) output.supplyDrops += xpValue * Number(drop.count || 0);
    });
    output.total = output.purchases + output.bonusXP + output.achievements + output.supplyDrops;
    if (output.total < Number(user.experiencePoints || 0)) {
      output.other = Number(user.experiencePoints || 0) - output.total;
      output.total += output.other;
    }
    return {
      purchases: output.purchases.toLocaleString("sv"),
      bonusXP: output.bonusXP.toLocaleString("sv"),
      achievements: output.achievements.toLocaleString("sv"),
      supplyDrops: output.supplyDrops.toLocaleString("sv"),
      other: output.other.toLocaleString("sv"),
      total: output.total.toLocaleString("sv"),
    };
  }

  function findTopHoarderCheevoStats(orders, count = 10) {
    const itemCount = {};
    orders.forEach((order) => {
      (order.rows || []).forEach((item) => {
        const id = item.product?.id || item.productId || item.id;
        if (!id) return;
        if (!itemCount[id]) {
          itemCount[id] = { id, name: item.product?.name || item.name || `Produkt ${id}`, bought: Number(item.quantity || 1) };
        } else {
          itemCount[id].bought += Number(item.quantity || 1);
        }
      });
    });
    return Object.values(itemCount)
      .filter((product) => product.bought > 1)
      .sort((a, b) => b.bought - a.bought)
      .slice(0, count);
  }

  function getOrderDatesPerMonthWithSum(orders) {
    return Object.entries(orders.reduce((acc, { orderDate, totalSum }) => {
      const dateOrdered = new Date(Number(orderDate || 0) * 1000);
      const orderKey = new Date(Date.UTC(dateOrdered.getUTCFullYear(), dateOrdered.getUTCMonth())).getTime() / 1000;
      if (!acc[orderKey]) {
        acc[orderKey] = { totalOrders: 1, totalSum: Number(totalSum || 0) };
      } else {
        acc[orderKey].totalOrders += 1;
        acc[orderKey].totalSum += Number(totalSum || 0);
      }
      return acc;
    }, {})).map(([key, { totalOrders, totalSum }]) => ({
      orderDate: parseInt(key, 10),
      totalOrders,
      totalSum,
    })).sort((a, b) => a.orderDate - b.orderDate);
  }

  function findOrdersPerMonth(orders) {
    const monthCounts = {};
    getOrderDatesPerMonthWithSum(orders).forEach((period) => {
      const currentDate = new Date(period.orderDate * 1000);
      const yearMonth = `${currentDate.getUTCFullYear()} ${MONTH_NAMES[currentDate.getUTCMonth()]}`;
      monthCounts[yearMonth] = { totalOrders: period.totalOrders, totalSum: period.totalSum };
    });
    return monthCounts;
  }

  function getStoreStats(orders) {
    const storePurchases = orders.reduce((stores, order) => {
      const storeName = order.store?.name;
      if (!storeName) return stores;
      stores[storeName] = (stores[storeName] || 0) + 1;
      return stores;
    }, {});
    const stores = new Map();
    Object.entries(storePurchases).sort((a, b) => b[1] - a[1]).forEach(([store, purchases]) => {
      stores.set(store, purchases);
    });
    const sumValues = Array.from(stores.values()).reduce((a, b) => a + b, 0);
    const storesNormalized = new Map();
    for (const [store, purchases] of stores) {
      storesNormalized.set(store, { purchases, normalizedValue: sumValues ? purchases / sumValues : 0 });
    }
    return new Map([...storesNormalized.entries()].sort((a, b) => a[1].normalizedValue - b[1].normalizedValue));
  }

  function getOrderDatesPerMonthWithSumKillstreak(orders) {
    return Object.entries(orders.reduce((acc, { orderDate, sentDate, totalSum }) => {
      const dateOrdered = new Date(Number(orderDate || 0) * 1000);
      const orderedYear = dateOrdered.getUTCFullYear();
      const orderedMonth = dateOrdered.getUTCMonth();
      const dateSent = new Date(Number(sentDate || orderDate || 0) * 1000);
      const sentYear = dateSent.getUTCFullYear();
      const sentMonth = dateSent.getUTCMonth();
      const sentKey = new Date(Date.UTC(sentYear, sentMonth)).getTime() / 1000;
      acc[sentKey] = { totalSum: Number(acc[sentKey]?.totalSum || 0) + Number(totalSum || 0) };
      if (sentYear !== orderedYear || sentMonth !== orderedMonth) {
        const orderKey = new Date(Date.UTC(orderedYear, orderedMonth)).getTime() / 1000;
        acc[orderKey] = { totalSum: Number(acc[orderKey]?.totalSum || 0) + Number(totalSum || 0) };
      }
      return acc;
    }, {})).map(([key, { totalSum }]) => ({
      sentDate: parseInt(key, 10),
      totalSum,
    })).sort((a, b) => a.sentDate - b.sentDate);
  }

  function findStreaks(orders, minimumSum = 500) {
    const cheevoStartDate = Date.parse("2015-09-01");
    const sentDates = getOrderDatesPerMonthWithSumKillstreak(orders);
    const output = { streaks: [], longestStreak: 0, currentStreak: 0 };
    let previousDate = null;
    let lastYearMonth = null;
    let currentStreakStart = null;

    for (let i = 0; i < sentDates.length; i++) {
      const currentDate = new Date(sentDates[i].sentDate * 1000);
      const yearMonth = `${currentDate.getUTCFullYear()} ${MONTH_NAMES[currentDate.getUTCMonth()]}`;
      if (currentDate.valueOf() < cheevoStartDate) continue;
      if (previousDate === null || lastYearMonth === null || currentStreakStart === null) {
        previousDate = currentDate;
        lastYearMonth = yearMonth;
        currentStreakStart = yearMonth;
      } else {
        const m1 = previousDate.getUTCMonth();
        const m2 = currentDate.getUTCMonth();
        const isConsecutive = m2 - m1 === 1 || m2 - m1 === -11;
        if (sentDates[i].totalSum >= minimumSum) {
          if (isConsecutive) {
            output.currentStreak++;
          } else {
            if (output.currentStreak > 0) output.streaks.push({ start: currentStreakStart, end: lastYearMonth, months: output.currentStreak });
            output.currentStreak = 0;
            currentStreakStart = yearMonth;
          }
          lastYearMonth = yearMonth;
          previousDate = currentDate;
        } else {
          if (output.currentStreak > 0) output.streaks.push({ start: currentStreakStart, end: lastYearMonth, months: output.currentStreak });
          output.currentStreak = 0;
          currentStreakStart = yearMonth;
        }
        output.longestStreak = Math.max(output.longestStreak, output.currentStreak);
        lastYearMonth = yearMonth;
        previousDate = currentDate;
      }
    }
    if (output.currentStreak > 0) output.streaks.push({ start: currentStreakStart, end: lastYearMonth, months: output.currentStreak });
    return output;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function createStatsTable(headers) {
    const table = el("table", { class: "table table-condensed table-striped tech-specs-table" });
    const thead = el("thead");
    thead.appendChild(el("tr", {}, headers.map((header) => el("th", { text: header }))));
    table.appendChild(thead);
    table.appendChild(el("tbody"));
    return table;
  }

  function parseSortableValue(value) {
    const text = String(value || "").trim().toLowerCase();
    const numeric = Number(text.replace(/\s/g, "").replace(",", ".").replace(/[^\d.-]/g, ""));
    return Number.isNaN(numeric) || text === "" ? text : numeric;
  }

  function addSortingFunctionality(table, headers) {
    const headerRow = table.querySelector("thead tr");
    if (!headerRow) return;

    headerRow.childNodes.forEach((header, columnIndex) => {
      header.style.cursor = "pointer";
      header.addEventListener("click", () => {
        const currentDir = header.dataset.sortDir === "asc" ? "desc" : "asc";
        const rows = Array.from(table.querySelector("tbody")?.rows || []);
        rows.sort((rowA, rowB) => {
          const valueA = parseSortableValue(rowA.cells[columnIndex]?.textContent);
          const valueB = parseSortableValue(rowB.cells[columnIndex]?.textContent);
          const result = typeof valueA === "number" && typeof valueB === "number"
            ? valueA - valueB
            : String(valueA).localeCompare(String(valueB), "sv");
          return currentDir === "asc" ? result : -result;
        });
        rows.forEach((row) => row.parentNode?.appendChild(row));
        headerRow.childNodes.forEach((node, index) => {
          node.textContent = headers[index] + (index === columnIndex ? (currentDir === "asc" ? "▲" : "▼") : "");
          node.dataset.sortDir = index === columnIndex ? currentDir : "";
        });
      });
    });
  }

  function appendTableRow(table, cells) {
    const row = el("tr");
    cells.forEach((cell) => {
      const td = el("td");
      if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = String(cell ?? "");
      row.appendChild(td);
    });
    table.querySelector("tbody")?.appendChild(row);
  }

  function addDataToDiv(headerText, domObject) {
    const div = el("div", { class: "order my-4" });
    const table = el("table", { class: "table table-condensed" });
    const tbody = el("tbody");
    const tr = el("tr", { class: "order-id-wrap" });
    tr.appendChild(el("td", { text: headerText }));
    tbody.appendChild(tr);
    table.appendChild(tbody);
    div.appendChild(table);

    const div1 = el("div");
    const div2 = el("div");
    const orderProgression = el("div");
    const innerContainer = el("div");
    const orderStatusEvent = el("div");
    const icon = el("div", { class: "icon" });
    const header = el("h3", { class: "level-two-heading" });
    const secondary = el("div");

    div1.appendChild(div2);
    div2.appendChild(orderProgression);
    orderProgression.appendChild(innerContainer);
    innerContainer.appendChild(orderStatusEvent);
    orderStatusEvent.appendChild(icon);
    orderStatusEvent.appendChild(header);
    orderStatusEvent.appendChild(secondary);
    secondary.appendChild(domObject);
    div.appendChild(div1);
    return div;
  }

  function generateMonthsTable(jsonData) {
    const headers = ["År Månad", "Totalt antal ordrar", "Total summa"];
    const table = createStatsTable(headers);
    let finalSum = 0;
    let finalOrders = 0;

    for (const month in jsonData) {
      const data = jsonData[month];
      appendTableRow(table, [month, data.totalOrders, data.totalSum]);
      finalOrders += data.totalOrders;
      finalSum += data.totalSum;
    }

    const footer = el("tfoot");
    const finalRow = el("tr");
    finalRow.appendChild(el("td", {}, [el("strong", { text: "Totalt" })]));
    finalRow.appendChild(el("td", {}, [el("strong", { text: String(finalOrders) })]));
    finalRow.appendChild(el("td", {}, [el("strong", { text: String(finalSum) })]));
    footer.appendChild(finalRow);
    table.appendChild(footer);
    addSortingFunctionality(table, headers);
    return table;
  }

  function generateStreaksTable(jsonData) {
    const div = el("div");
    const table1 = createStatsTable(["Längsta streak", "Nuvarande streak"]);
    appendTableRow(table1, [jsonData.longestStreak, jsonData.currentStreak]);

    const table2 = createStatsTable(["Streak började", "Streak slutade", "Antal månader"]);
    jsonData.streaks.forEach((streak) => {
      appendTableRow(table2, [streak.start, streak.end, streak.months]);
    });

    div.appendChild(table1);
    div.appendChild(table2);
    return div;
  }

  function generateCategoriesTable(jsonData) {
    const headers = ["Kategori", "Antal produkter"];
    const table = createStatsTable(headers);
    for (const category in jsonData) {
      appendTableRow(table, [category, jsonData[category]]);
    }
    addSortingFunctionality(table, headers);
    return table;
  }

  function generateExperienceTable(jsonData) {
    const table = createStatsTable(["Köp XP", "Bonus XP", "Cheevo XP", "Supply drop XP", "Övriga XP", "Totalt"]);
    appendTableRow(table, [jsonData.purchases, jsonData.bonusXP, jsonData.achievements, jsonData.supplyDrops, jsonData.other, jsonData.total]);
    return table;
  }

  function generateHoarderTable(jsonData) {
    const table = createStatsTable(["Produkt", "Antal köpta"]);
    jsonData.forEach((product) => {
      const link = el("a", { href: `https://www.webhallen.com/${product.id}` }, [`[${product.id}] ${product.name}`]);
      appendTableRow(table, [link, product.bought]);
    });
    return table;
  }

  function generateStoresChart(storeSums) {
    const div = el("div", { id: "stores-chart" });
    div.style.width = "100%";
    div.style.maxWidth = "900px";
    div.style.margin = "0 auto";
    div.style.display = "flex";
    div.style.flexDirection = "row";
    div.style.gap = "40px";

    const table = el("table", { class: "table table-condensed charts-css pie hide-data show-primary-axis" });
    const thead = el("thead");
    const theadtr = el("tr");
    theadtr.appendChild(el("th", { scope: "col" }));
    theadtr.appendChild(el("th", { scope: "col" }));
    thead.appendChild(theadtr);

    const tbody = el("tbody");
    const ul = el("ul", { class: "charts-css legend legend-square", style: "flex-direction: column-reverse;" });
    let prev = 0;
    storeSums.forEach((value, store) => {
      const tr = el("tr");
      const th = el("th", { scope: "col", text: store });
      const td = el("td", { style: `--start: ${prev}; --end: ${prev + value.normalizedValue};` });
      prev += value.normalizedValue;
      td.appendChild(el("span", { class: "data", text: String(value.purchases) }));
      tr.appendChild(th);
      tr.appendChild(td);
      tbody.appendChild(tr);
      ul.appendChild(el("li", { text: `${store}: ${value.purchases}` }));
    });

    table.appendChild(thead);
    table.appendChild(tbody);
    div.appendChild(table);
    div.appendChild(ul);
    return div;
  }

  function getPostedReviews(reviews) {
    return reviews.filter((orderReview) => orderReview.review).sort((a, b) => {
      return Number(b.review?.createdAt || 0) - Number(a.review?.createdAt || 0);
    });
  }

  function getProductsWithoutReviews(reviews) {
    return reviews.filter((orderReview) => !orderReview.review);
  }

  function generateReviewTable(reviewData) {
    const table = el("table", { class: "table table-condensed table-striped tech-specs-table" });
    reviewData.forEach((review) => {
      if (!review.review) return;
      const tbody = el("tbody");
      const row1 = el("tr");
      const row2 = el("tr");
      const productCell = el("td");
      const timestampCell = el("td");
      const scoreCell = el("td");
      const voteCell = el("td");
      const reviewCell = el("td");

      productCell.style.whiteSpace = "normal";
      productCell.style.wordBreak = "normal";
      productCell.appendChild(el("a", {
        href: `https://www.webhallen.com/${review.product}`,
        target: "_blank",
        rel: "noopener noreferrer",
      }, [`${review.product} ${review.review.product?.name || review.productName || ""}`]));

      timestampCell.style.textAlign = "center";
      const timestamp = el("span", {
        title: unixTimestampToLocale(review.review.createdAt),
        text: timeAgo(review.review.createdAt),
      });
      timestampCell.appendChild(timestamp);

      scoreCell.style.textAlign = "center";
      const starsDiv = el("div", { class: "stars", title: `${review.review.rating} / 5` });
      starsDiv.style.textAlign = "middle";
      const starsContentDiv = el("div", { class: "stars-content stars-content-bg" });
      starsContentDiv.style.width = `${Number(review.review.rating || 0) / 5 * 100}%`;
      starsDiv.appendChild(starsContentDiv);
      scoreCell.appendChild(starsDiv);

      voteCell.style.textAlign = "right";
      const votesDiv = el("div", { class: "votes" });
      const thumbUp = el("span", {
        title: "Tumme upp",
        class: "vote vote-up secondary",
        text: String(review.review.upvotes || 0),
      });
      thumbUp.style.cursor = "auto";
      thumbUp.style.userSelect = "auto";
      const thumbDown = el("span", {
        title: "Tumme ner",
        class: "vote vote-down secondary",
        text: String(review.review.downvotes || 0),
      });
      thumbDown.style.cursor = "auto";
      thumbDown.style.userSelect = "auto";
      votesDiv.appendChild(thumbUp);
      votesDiv.appendChild(thumbDown);
      voteCell.appendChild(votesDiv);

      reviewCell.style.whiteSpace = "normal";
      reviewCell.style.wordBreak = "normal";
      reviewCell.colSpan = 4;
      reviewCell.textContent = review.review.text || "";

      row1.appendChild(productCell);
      row1.appendChild(timestampCell);
      row1.appendChild(scoreCell);
      row1.appendChild(voteCell);
      row2.appendChild(reviewCell);
      tbody.appendChild(row1);
      tbody.appendChild(row2);
      table.appendChild(tbody);
    });
    return table;
  }

  function generateMissingReviewTable(reviewData) {
    const table = el("table", { class: "table table-condensed table-striped tech-specs-table" });
    const tbody = el("tbody");
    reviewData.forEach((review) => {
      const row = el("tr");
      const productCell = el("td");
      productCell.appendChild(el("a", {
        href: `https://www.webhallen.com/${review.product}`,
        target: "_blank",
        rel: "noopener noreferrer",
      }, [`${review.product}${review.productName ? ` ${review.productName}` : ""}`]));
      row.appendChild(productCell);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    return table;
  }

  function setSyncStatus(status, message = "", isSyncing = false) {
    if (!status) return;
    status.textContent = "";
    if (!message) return;
    if (isSyncing) {
      status.appendChild(el("strong", { class: "whcs-sync-prefix", text: "Uppdaterar cache: " }));
    }
    status.appendChild(document.createTextNode(message));
  }

  function setSyncButtonsDisabled(container, disabled) {
    container.querySelectorAll(".whcs-actions button").forEach((button) => {
      button.disabled = disabled;
      button.classList.toggle("whcs-disabled", disabled);
    });
  }

  function setVirtualLinkActive(selector) {
    document.querySelectorAll(".router-link-exact-active.router-link-active").forEach((link) => {
      link.classList.remove("router-link-exact-active", "router-link-active");
    });
    document.querySelectorAll(".member-nav li.active").forEach((item) => {
      item.classList.remove("active");
    });

    const link = document.querySelector(selector);
    if (link) {
      link.classList.add("router-link-exact-active", "router-link-active");
      link.closest("li")?.classList.add("active");
    }
  }

  function setStatsLinkActive() {
    setVirtualLinkActive("[data-whcs-stats-link]");
  }

  function setReviewsLinkActive() {
    setVirtualLinkActive("[data-whcs-reviews-link]");
  }

  function clearVirtualLinkActive() {
    document.querySelectorAll("[data-whcs-stats-link], [data-whcs-reviews-link]").forEach((link) => {
      link.classList.remove("router-link-exact-active", "router-link-active");
      link.closest("li")?.classList.remove("active");
    });
  }

  async function renderStats(container, user, orders, meta) {
    container.innerHTML = "";
    setStatsLinkActive();
    if (!chartsStylesInjected) {
      chartsStylesInjected = true;
      GM_addStyle('@import url("https://unpkg.com/charts.css/dist/charts.min.css");');
    }

    container.appendChild(el("h2", { class: "level-one-heading mb-5", text: "Min statistik" }));
    container.appendChild(el("hr"));
    container.appendChild(el("div", {
      class: "mb-5",
      text: "Här hittar du statistik om din aktivitet på webhallen.",
    }));

    const actions = el("div", { class: "whcs-actions" });
    const status = el("div", { class: "whcs-status" });
    actions.appendChild(el("button", {
      class: "text-btn",
      type: "button",
      onclick: async () => {
        await runSyncAndRender(container, user, { full: false, status });
      },
      text: "Uppdatera nya ordrar",
    }));
    actions.appendChild(el("button", {
      class: "text-btn",
      type: "button",
      onclick: async () => {
        if (!confirm("Bygga om ordercache från början? Detta kan ta en stund.")) return;
        await clearOrderCache(user.id);
        await runSyncAndRender(container, user, { full: true, status });
      },
      text: "Bygg om cache",
    }));
    actions.appendChild(el("button", {
      class: "text-btn",
      type: "button",
      onclick: () => {
        if (!orders.length) {
          setSyncStatus(status, "Det finns ingen ordercache att exportera ännu.");
          return;
        }
        const exportedRows = exportOrdersCsv(orders, user.id);
        setSyncStatus(status, `Exporterade ${exportedRows} orderrader.`);
      },
      text: "Exportera data",
    }));
    container.appendChild(actions);
    const cacheNote = el("div", {
      class: "whcs-cache-note",
      text: `Ordercache: ${orders.length} ordrar, ${orderRows(orders).length} orderrader. Senast synkad: ${formatDateTime(meta?.lastSyncAt)}.`,
    });
    cacheNote.appendChild(status);
    container.appendChild(cacheNote);

    if (!orders.length) {
      container.appendChild(addDataToDiv("Status", el("div", {
        class: "whcs-empty",
        text: "Ingen lokal ordercache hittades ännu. Klicka på Uppdatera nya ordrar för att börja.",
      })));
      return;
    }

    const loading = el("div", { class: "whcs-cache-note", text: "Hämtar achievements och supply drops..." });
    container.appendChild(loading);

    let achievements = [];
    let supplyDrops = [];
    try {
      [achievements, supplyDrops] = await Promise.all([fetchAchievements(user.id), fetchSupplyDrops()]);
    } catch (error) {
      console.warn("Could not fetch achievements or supply drops for experience stats.", error);
    }
    loading.remove();

    const experience = getExperienceStats(user, orders, achievements, supplyDrops);
    container.appendChild(addDataToDiv("Experience", generateExperienceTable(experience)));

    const stores = getStoreStats(orders);
    container.appendChild(addDataToDiv("Stores", generateStoresChart(stores)));

    const streaks = findStreaks(orders);
    container.appendChild(addDataToDiv("Streaks", generateStreaksTable(streaks)));

    const hoarder = findTopHoarderCheevoStats(orders, 10);
    container.appendChild(addDataToDiv("Hoarder Top 10", generateHoarderTable(hoarder)));

    const categories = findCategoriesByPeriod(orders);
    container.appendChild(addDataToDiv("Kategorier", generateCategoriesTable(categories)));

    const orderMonths = findOrdersPerMonth(orders);
    container.appendChild(addDataToDiv("Ordrar per månad", generateMonthsTable(orderMonths)));
  }

  async function runSyncAndRender(container, user, { full, status }) {
    const syncKey = String(user.id);
    if (syncingUsers.has(syncKey)) return;

    syncingUsers.add(syncKey);
    setSyncButtonsDisabled(container, true);
    setSyncStatus(status, full ? "Bygger om cache..." : "Söker nya ordrar...", true);

    try {
      const result = await syncOrders(user.id, {
        full,
        onProgress: ({ page, fetched, canStopAtKnownOrder }) => {
          const message = canStopAtKnownOrder
            ? `Ordrar hämtade under körningen: ${fetched}.`
            : `Hämtar sida ${page}. Ordrar hämtade under körningen: ${fetched}.`;
          setSyncStatus(status, message, true);
        },
      });
      setSyncStatus(status, `Klart. Hämtade ${result.fetched} nya ordrar.`);
      await renderStats(container, user, result.orders, result.meta);
    } finally {
      syncingUsers.delete(syncKey);
      setSyncButtonsDisabled(container, false);
    }
  }

  async function runReviewSyncAndRender(container, user, { status }) {
    const syncKey = `${user.id}:reviews`;
    if (syncingUsers.has(syncKey)) return;

    const orders = await getCachedOrders(user.id);
    const products = purchasedProductsFromOrders(orders);
    if (!products.length) {
      setSyncStatus(status, "Ingen ordercache hittades. Gå till Statistik och bygg ordercache först.");
      return;
    }

    syncingUsers.add(syncKey);
    setSyncButtonsDisabled(container, true);
    try {
      const result = await syncReviews(user.id, products, {
        onProgress: ({ current, total }) => {
          setSyncStatus(status, `Hämtar recensioner för produkt ${Math.min(current + 1, total)} av ${total}.`, true);
        },
      });
      setSyncStatus(status, `Klart. Kontrollerade ${products.length} produkter.`);
      await renderReviews(container, user, result.rows, result.meta);
    } finally {
      syncingUsers.delete(syncKey);
      setSyncButtonsDisabled(container, false);
    }
  }

  function findInjectPath() {
    const selectors = ["section", "div.member-subpage", "div.container"];
    let target = null;
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (node) target = node;
    }
    return target;
  }

  function renderError(message) {
    const container = findInjectPath();
    if (!container) {
      alert(message);
      return;
    }
    container.innerHTML = "";
    container.appendChild(el("h2", { class: "level-one-heading mb-5", text: "Min statistik" }));
    container.appendChild(el("hr"));
    container.appendChild(addDataToDiv("Fel", el("div", { class: "whcs-empty", text: message })));
  }

  async function showStats(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    try {
      const user = await fetchMe();
      if (!user) {
        renderError("Kunde inte hitta inloggad Webhallen-användare.");
        return;
      }

      const container = findInjectPath();
      if (!container) {
        alert("Kunde inte hitta rätt plats att visa statistiken på. Prova att ladda om Webhallen-sidan.");
        return;
      }

      const orders = await getCachedOrders(user.id);
      const meta = await getMeta(user.id);
      await renderStats(container, user, orders, meta);

      if (!orders.length) {
        const status = container.querySelector(".whcs-status");
        await runSyncAndRender(container, user, { full: true, status });
      }
    } catch (error) {
      console.error(error);
      renderError(`Kunde inte visa statistik: ${error.message || error}`);
    }
  }

  async function renderReviews(container, user, reviewRows, meta) {
    container.innerHTML = "";
    setReviewsLinkActive();

    container.appendChild(el("h2", { class: "level-one-heading mb-5", text: "Mina recensioner" }));
    container.appendChild(el("hr"));
    container.appendChild(el("div", {
      class: "mb-5",
      text: "Här hittar du dina recensioner och köpta produkter som saknar recension. Datan sparas lokalt i webbläsaren.",
    }));
    container.appendChild(el("div", {
      class: "whcs-notice mb-5",
      text: "Obs: Recensioner där du valt att dölja användarnamnet kan inte matchas mot ditt konto via Webhallens publika produktrecensioner och kan därför visas som saknade.",
    }));

    const actions = el("div", { class: "whcs-actions" });
    const status = el("div", { class: "whcs-status" });
    actions.appendChild(el("button", {
      class: "text-btn",
      type: "button",
      onclick: async () => {
        await runReviewSyncAndRender(container, user, { status });
      },
      text: "Synka recensioner",
    }));
    container.appendChild(actions);

    const cacheNote = el("div", {
      class: "whcs-cache-note",
      text: `Reviewcache: ${reviewRows.length} produkter. Senast synkad: ${formatDateTime(meta?.lastReviewSyncAt)}.`,
    });
    cacheNote.appendChild(status);
    container.appendChild(cacheNote);

    if (!reviewRows.length) {
      container.appendChild(addDataToDiv("Status", el("div", {
        class: "whcs-empty",
        text: "Ingen reviewcache hittades ännu. Klicka på Synka recensioner för att börja.",
      })));
      return;
    }

    const userReviews = getPostedReviews(reviewRows);
    const missingReviews = getProductsWithoutReviews(reviewRows);

    if (userReviews.length) {
      container.appendChild(addDataToDiv("Recensioner", generateReviewTable(userReviews)));
    } else {
      container.appendChild(addDataToDiv("Recensioner", el("div", {
        class: "whcs-empty",
        text: "Hittade inga publicerade recensioner i den lokala reviewcachen.",
      })));
    }

    if (missingReviews.length) {
      container.appendChild(addDataToDiv("Produkter du köpt som saknar recension", generateMissingReviewTable(missingReviews)));
    }
  }

  async function showReviews(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    try {
      const user = await fetchMe();
      if (!user) {
        renderError("Kunde inte hitta inloggad Webhallen-användare.");
        return;
      }
      const container = findInjectPath();
      if (!container) {
        alert("Kunde inte hitta rätt plats att visa recensionerna på. Prova att ladda om Webhallen-sidan.");
        return;
      }
      const rows = await getCachedReviewRows(user.id);
      const meta = await getMeta(`${user.id}:reviews`);
      await renderReviews(container, user, rows, meta);
    } catch (error) {
      console.error(error);
      renderError(`Kunde inte visa recensioner: ${error.message || error}`);
    }
  }

  function addStatsLink() {
    if (document.querySelector("[data-whcs-stats-link]")) return;
    const nav = document.querySelector(".member-nav .desktop-wrap .nav");
    if (!nav) return;

    const item = el("li", { class: "tile" });
    const link = el("a", {
      href: "#",
      "data-whcs-stats-link": "1",
      title: "Visa statistik från lokal cache",
    });
    const image = el("img", {
      src: "//www.webhallen.com/img/icons/member/topplistor.svg",
      class: "member-icon",
      alt: "Statistik (cached ver.)",
    });
    link.appendChild(image);
    link.appendChild(document.createTextNode("Statistik (cached ver.)"));
    item.appendChild(link);
    nav.appendChild(item);
  }

  function addReviewsLink() {
    if (document.querySelector("[data-whcs-reviews-link]")) return;
    const nav = document.querySelector(".member-nav .desktop-wrap .nav");
    if (!nav) return;

    const item = el("li", { class: "tile" });
    const link = el("a", {
      href: "#",
      "data-whcs-reviews-link": "1",
      title: "Visa recensioner från lokal cache",
    });
    const image = el("img", {
      src: "//www.webhallen.com/img/icons/feed/feed_review.svg",
      class: "member-icon",
      alt: "Recensioner (cached ver.)",
    });
    link.appendChild(image);
    link.appendChild(document.createTextNode("Recensioner (cached ver.)"));
    item.appendChild(link);
    nav.appendChild(item);
  }

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    GM_addStyle(`
      .whcs-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
      [data-whcs-stats-link] { cursor: pointer; }
      .whcs-status { font-weight: 700; }
      .whcs-cache-note { margin: 8px 0 16px; color: #777; }
      .whcs-status { display: block; margin-top: 6px; }
      .whcs-sync-prefix { color: #d50855; }
      .whcs-notice { color: #d50855; font-weight: 700; }
      .whcs-actions button.whcs-disabled,
      .whcs-actions button:disabled { cursor: wait; opacity: .45; }
      [data-whcs-reviews-link] { cursor: pointer; }
    `);
  }

  function boot() {
    injectStyles();
    clearVirtualLinkActive();
    if (location.pathname.startsWith("/se/member")) {
      fetchMe().then((user) => {
        if (user) {
          addStatsLink();
          addReviewsLink();
        }
      }).catch(console.error);
    }
  }

  boot();
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;

    const link = event.target.closest("[data-whcs-stats-link]");
    if (link) {
      showStats(event);
      return;
    }

    const reviewsLink = event.target.closest("[data-whcs-reviews-link]");
    if (reviewsLink) {
      showReviews(event);
      return;
    }

    if (event.target.closest(".member-nav a")) {
      clearVirtualLinkActive();
    }
  }, true);
  window.addEventListener("urlchange", boot);
  new MutationObserver(() => {
    addStatsLink();
    addReviewsLink();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
