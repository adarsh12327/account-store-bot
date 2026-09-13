const db = require("./database");

async function main() {
  const products = await db.listProducts();

  let fixed = 0;
  let skipped = 0;

  for (const product of products) {
    const oldPrice = Number(product.finalPrice || 0);

    let newPrice = 0;

    if (product.priceMode === "API") {
      newPrice = Number(product.apiPrice || 0);
    } else {
      newPrice = Number(product.manualPrice || 0);
    }

    newPrice = Number(newPrice.toFixed(2));

    if (oldPrice === newPrice) {
      skipped++;
      continue;
    }

    await db.updateProduct(product.id, {
      finalPrice: newPrice
    });

    console.log(
      `✅ ${product.name}: ₹${oldPrice.toFixed(2)} → ₹${newPrice.toFixed(2)}`
    );

    fixed++;
  }

  console.log("\n================================");
  console.log(`✅ Fixed: ${fixed}`);
  console.log(`⏭️ Already correct: ${skipped}`);
  console.log(`📦 Total: ${products.length}`);
  console.log("================================");

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
