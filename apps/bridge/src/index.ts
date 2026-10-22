import { productPaths } from "./config/paths.js";
import { loadProduct } from "./config/product.js";
import { startNativeSlack } from "./native-main.js";

await startNativeSlack(loadProduct(productPaths())).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Native Slack startup failed"}\n`,
  );
  process.exitCode = 1;
});
