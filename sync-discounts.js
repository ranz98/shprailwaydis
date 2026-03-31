require("dotenv").config();
const fetch = require("node-fetch");

const SHOP  = process.env.SHOP_DOMAIN;
const TOKEN = process.env.ACCESS_TOKEN;

// ─── GraphQL helper (with throttle handling) ──────────────────
async function shopifyGraphQL(query, variables = {}, attempt = 0) {
  const res = await fetch(
    `https://${SHOP}/admin/api/2024-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  // Handle HTTP-level throttle (429)
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
    console.warn(`⏳ HTTP 429 – waiting ${retryAfter}s before retry...`);
    await sleep(retryAfter * 1000);
    return shopifyGraphQL(query, variables, attempt + 1);
  }

  if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);

  const json = await res.json();

  // Handle GraphQL-level THROTTLED error
  if (json.errors) {
    const throttled = json.errors.some(e => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 6) {
      const wait = Math.min(2000 * (attempt + 1), 16000);
      console.warn(`⏳ GraphQL THROTTLED – waiting ${wait}ms before retry...`);
      await sleep(wait);
      return shopifyGraphQL(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// ─── Sleep helper ─────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Retry wrapper ───────────────────────────────────────────
async function retryUpdate(productId, variantUpdates, retries = 3) {
  try {
    return await updateProductVariants(productId, variantUpdates);
  } catch (err) {
    if (retries === 0) throw err;
    console.warn(`⚠️ Retry ${productId}... (${retries})`);
    await sleep(1000 * (4 - retries));
    return retryUpdate(productId, variantUpdates, retries - 1);
  }
}

// ─── Fetch automatic % discounts safely ───────────────────────
const GET_DISCOUNTS_QUERY = `
query {
  automaticDiscountNodes(first: 50) {
    edges {
      node {
        automaticDiscount {
          __typename
          ... on DiscountAutomaticBasic {
            title
            status
            customerGets {
              value {
                ... on DiscountPercentage {
                  percentage
                }
              }
              items {
                ... on DiscountCollections {
                  collections(first: 50) {
                    edges { node { id title } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

function parseDiscounts(data) {
  const map = {};
  for (const { node } of data.automaticDiscountNodes.edges) {
    const discount = node.automaticDiscount;

    // Only handle DiscountAutomaticBasic
    if (!discount || discount.__typename !== "DiscountAutomaticBasic") continue;
    if (discount.status !== "ACTIVE") continue;

    const percentage = discount.customerGets?.value?.percentage;
    if (!percentage) continue; // skip fixed amount discounts

    const pct = Math.round(percentage * 100);
    const collections = discount.customerGets?.items?.collections?.edges ?? [];

    for (const { node: col } of collections) {
      // Keep highest % if multiple discounts apply to same collection
      if (!map[col.id] || pct > map[col.id].pct) {
        map[col.id] = { pct, title: col.title };
      }
    }
  }
  return map;
}

// ─── Fetch all products + variants in a collection ────────────
const GET_COLLECTION_PRODUCTS = `
query GetCollectionProducts($id: ID!, $cursor: String) {
  collection(id: $id) {
    title
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          variants(first: 100) {
            edges { node { id price compareAtPrice } }
          }
        }
      }
    }
  }
}
`;

async function getCollectionProducts(collectionId) {
  const products = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphQL(GET_COLLECTION_PRODUCTS, { id: collectionId, cursor });
    const page = data.collection.products;
    for (const { node: product } of page.edges) {
      products.push({
        id: product.id,
        title: product.title,
        variants: product.variants.edges.map(e => e.node)
      });
    }
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }

  return products;
}

// ─── Bulk update variants ────────────────────────────────────
const BULK_UPDATE_MUTATION = `
mutation BulkUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id compareAtPrice }
    userErrors { field message }
  }
}
`;

async function updateProductVariants(productId, variantUpdates) {
  const data = await shopifyGraphQL(BULK_UPDATE_MUTATION, {
    productId,
    variants: variantUpdates
  });

  const errors = data.productVariantsBulkUpdate?.userErrors ?? [];
  if (errors.length) {
    console.error(`ERROR on ${productId}:`, errors);
    throw new Error(errors.map(e => e.message).join(", "));
  }

  // Log what Shopify actually stored
  const updated = data.productVariantsBulkUpdate?.productVariants ?? [];
  for (const v of updated) {
    console.log(`  ✔ variant ${v.id} → compareAtPrice=${v.compareAtPrice}`);
  }
  return true;
}

// ─── Apply discount safely ────────────────────────────────────
async function applyDiscountToCollection(collectionId, collectionTitle, pct) {
  console.log(`Collection: "${collectionTitle}" applying ${pct}%`);
  const products = await getCollectionProducts(collectionId);
  console.log(`Found ${products.length} products`);

  const CONCURRENCY = 1;  // Sequential to stay within Shopify's 50 pts/sec refill
  const DELAY = 300;      // ~3 mutations/sec (10 pts each) — safely under the limit
  let index = 0;

  async function worker() {
    while (index < products.length) {
      const product = products[index++];
      try {
        const variantUpdates = product.variants.map(variant => {
          const price = parseFloat(variant.price);
          const compareAt = (price / (1 - pct / 100)).toFixed(2);
          console.log(`  product "${product.title}" variant ${variant.id}: price=${price}, compareAt=${compareAt}`);
          return { id: variant.id, compareAtPrice: compareAt };
        });
        await retryUpdate(product.id, variantUpdates);
      } catch (err) {
        console.error(`Failed ${product.title}:`, err.message);
      }
      await sleep(DELAY);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`✅ Done "${collectionTitle}"`);
}

// ─── Clear compare_at_price ───────────────────────────────────
async function clearDiscountFromCollection(collectionId, collectionTitle) {
  console.log(`Clearing compare_at_price on "${collectionTitle}"...`);
  const products = await getCollectionProducts(collectionId);
  for (const product of products) {
    const variantsWithCompareAt = product.variants.filter(v => v.compareAtPrice);
    if (!variantsWithCompareAt.length) continue;
    const updates = variantsWithCompareAt.map(v => ({ id: v.id, compareAtPrice: null }));
    await retryUpdate(product.id, updates);
    await sleep(150);
  }
}

// ─── Main sync ───────────────────────────────────────────────
async function syncDiscounts() {
  console.log("Syncing discounts...");

  const data = await shopifyGraphQL(GET_DISCOUNTS_QUERY);
  const discountMap = parseDiscounts(data);

  for (const [colId, { pct, title }] of Object.entries(discountMap)) {
    await applyDiscountToCollection(colId, title, pct);
  }

  // Clear old discountsxxx
  const allDiscountData = await shopifyGraphQL(`
    query {
      automaticDiscountNodes(first: 50) {
        edges {
          node {
            automaticDiscount {
              __typename
              ... on DiscountAutomaticBasic {
                customerGets {
                  items {
                    ... on DiscountCollections {
                      collections(first: 50) {
                        edges { node { id title } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const allCollections = new Map();
  for (const { node } of allDiscountData.automaticDiscountNodes.edges) {
    // After the DiscountAutomaticBasic fragment fix, customerGets lives inside the typed object
    const discount = node.automaticDiscount;
    if (!discount || discount.__typename !== "DiscountAutomaticBasic") continue;
    const collections = discount.customerGets?.items?.collections?.edges ?? [];
    for (const { node: col } of collections) allCollections.set(col.id, col.title);
  }

  for (const [colId, colTitle] of allCollections) {
    if (!discountMap[colId]) await clearDiscountFromCollection(colId, colTitle);
  }

  console.log("Sync complete.");
  return discountMap;
}

module.exports = { syncDiscounts };