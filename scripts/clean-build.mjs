import { rmSync } from "node:fs";

rmSync(new URL("../apps/bridge/dist/", import.meta.url), { recursive: true, force: true });
