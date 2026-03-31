require("dotenv").config();
const express  = require("express");
const crypto   = require("crypto");
const { syncDiscounts } = require("./sync-discounts");

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.SHOPIFY_API_SECRET;

// ─── Raw body for webhook verification ─────────────────────────
app.use(express.json({
  verify: (req, _res, buf) => req.rawBody = buf
}));

// ─── Webhook signature verification ───────────────────────────
function verifyWebhook(req, res, next) {
  const hmac      = req.headers["x-shopify-hmac-sha256"];
  const generated = crypto.createHmac("sha256", SECRET).update(req.rawBody).digest("base64");
  if (hmac !== generated) return res.status(401).send("Unauthorized");
  next();
}

// ─── Webhooks ─────────────────────────────────────────────────
app.post("/webhooks/discounts/create", verifyWebhook, async (req, res) => {
  console.log("Webhook: discount created →", req.body?.title ?? "(no title)");
  runSync("discount created");
  res.sendStatus(200);
});
app.post("/webhooks/discounts/update", verifyWebhook, async (req, res) => {
  console.log("Webhook: discount updated →", req.body?.title ?? "(no title)");
  runSync("discount updated");
  res.sendStatus(200);
});
app.post("/webhooks/discounts/delete", verifyWebhook, async (req, res) => {
  console.log("Webhook: discount deleted →", req.body?.admin_graphql_api_id ?? "(no id)");
  runSync("discount deleted");
  res.sendStatus(200);
});

// ─── Manual sync endpoint ──────────────────────────────────────
app.get("/sync", async (_req, res) => {
  try {
    const result = await syncDiscounts();
    res.json({ ok: true, synced: Object.keys(result).length, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────
app.get("/", (_req, res) => res.json({ status: "ok", message: "Shopify Discount server running updated" }));

// ─── Run server ──────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ─── Helper ─────────────────────────────────────────────────
async function runSync(reason) {
  try {
    console.log(`Delaying sync for 3 seconds (reason: ${reason})...`);
    // Wait for Shopify to mark the discount as ACTIVE in the API
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Running sync...`);
    await syncDiscounts();
  } catch (err) {
    console.error("Sync error:", err.message);
  }
}