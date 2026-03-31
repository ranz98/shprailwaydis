require("dotenv").config();
const fetch = require("node-fetch");

const SHOP  = process.env.SHOP_DOMAIN;
const TOKEN = process.env.ACCESS_TOKEN;

// ─── GraphQL helper ───────────────────────────────────────────
async function shopifyGraphQL(query, variables = {}) {
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

  if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);

  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
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
  return true;
}

// ─── Apply discount safely ────────────────────────────────────
async function applyDiscountToCollection(collectionId, collectionTitle, pct) {
  console.log(`Collection: "${collectionTitle}" applying ${pct}%`);
  const products = await getCollectionProducts(collectionId);
  console.log(`Found ${products.length} products`);

  const CONCURRENCY = 3;
  const DELAY = 150;
  let index = 0;

  async function worker() {
    while (index < products.length) {
      const product = products[index++];
      try {
        const variantUpdates = product.variants.map(variant => {
          const price = parseFloat(variant.price);
          const compareAt = (price / (1 - pct / 100)).toFixed(2);
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

  // Clear old discountsx
  const allDiscountData = await shopifyGraphQL(`
    query {
      automaticDiscountNodes(first: 50) {
        edges {
          node {
            automaticDiscount {
              __typename
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
  `);

  const allCollections = new Map();
  for (const { node } of allDiscountData.automaticDiscountNodes.edges) {
    const collections = node.automaticDiscount?.customerGets?.items?.collections?.edges ?? [];
    for (const { node: col } of collections) allCollections.set(col.id, col.title);
  }

  for (const [colId, colTitle] of allCollections) {
    if (!discountMap[colId]) await clearDiscountFromCollection(colId, colTitle);
  }

  console.log("Sync complete.");
  return discountMap;
}

module.exports = { syncDiscounts };