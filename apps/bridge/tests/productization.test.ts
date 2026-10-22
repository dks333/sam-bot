import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { launchAgentPlist } from "../src/cli/launch-agent.js";
import { downloadSlackImages, parseSlackImages } from "../src/slack/images.js";
import { productPaths } from "../src/config/paths.js";
import {
  defaultProductConfig,
  effectiveCodexHome,
  loadProduct,
  productConfigType,
  readProductConfig,
  readProductSecrets,
} from "../src/config/product.js";
import { parseArk } from "../src/validation/parse.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "native-product-"));
  directories.push(directory);
  return { directory, paths: productPaths(directory), config: defaultProductConfig(directory) };
}

describe("native product configuration", () => {
  it("defaults to native Codex without enabling retired controllers", () => {
    const { config } = fixture();
    expect(config.runtime.agentProvider).toBe("codex");
    expect(config).not.toHaveProperty("browser");
    expect(config).not.toHaveProperty("routing");
    expect(config).not.toHaveProperty("independentReview");
    expect(config.runtime).not.toHaveProperty("autoApprovePullRequests");
    expect(config.slack).not.toHaveProperty("disabledMcpServers");
  });

  it("preserves legacy and unknown settings without interpreting retired fields", () => {
    const { paths, config } = fixture();
    const saved = {
      ...config,
      browser: { enabled: "legacy" },
      routing: { policyMode: "legacy" },
      futureSetting: { enabled: true },
      runtime: { ...config.runtime, approvalTtlSeconds: "legacy" },
      codex: { ...config.codex, intentProfiles: { retained: true } },
    };
    writeFileSync(paths.configFile, JSON.stringify(saved), { mode: 0o600 });
    const before = readFileSync(paths.configFile, "utf8");
    expect(readProductConfig(paths)).toEqual(saved);
    expect(readFileSync(paths.configFile, "utf8")).toBe(before);
  });

  it("retains native executable, model, profile home, and Slack identity options", () => {
    const { config, paths } = fixture();
    const saved = {
      ...config,
      codex: { home: "/synthetic/codex-profile", executablePath: "/synthetic/bin/codex" },
      claude: { executablePath: "/synthetic/bin/claude", model: "synthetic-model" },
      runtime: { ...config.runtime, agentProvider: "claude" },
      slack: { ...config.slack, allowedEnterpriseId: "synthetic-enterprise" },
    };
    writeFileSync(paths.configFile, JSON.stringify(saved), { mode: 0o600 });
    writeFileSync(
      paths.secretsFile,
      "SLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\nTYPESAFE_API_KEY=retained-synthetic-value\n",
      { mode: 0o600 },
    );
    const before = readFileSync(paths.secretsFile, "utf8");
    const loaded = loadProduct(paths);
    expect(loaded.config).toEqual(saved);
    expect(loaded.bridge).toMatchObject({
      codexHome: "/synthetic/codex-profile",
      allowedEnterpriseId: "synthetic-enterprise",
    });
    expect(readProductSecrets(paths)).toHaveProperty(
      "TYPESAFE_API_KEY",
      "retained-synthetic-value",
    );
    expect(readFileSync(paths.secretsFile, "utf8")).toBe(before);
  });

  it("retains the native Codex default when an older configuration has no provider", () => {
    const { config } = fixture();
    const { agentProvider: _agentProvider, ...runtime } = config.runtime;
    const parsed = parseArk(productConfigType, { ...config, runtime }, "config");
    expect(parsed.runtime.agentProvider ?? "codex").toBe("codex");
  });

  it.each([
    { label: "relative workspace", change: { workspaces: { default: "../outside" } } },
    {
      label: "unknown provider",
      change: {
        runtime: { agentProvider: "unknown", logLevel: "info", maxSlackResponseChars: 3500 },
      },
    },
    {
      label: "empty channels",
      change: {
        slack: {
          allowedChannelIds: [],
          allowedUserId: "synthetic-owner",
          allowedTeamId: "synthetic-team",
        },
      },
    },
    {
      label: "missing workspace alias",
      change: {
        runtime: {
          defaultWorkspaceAlias: "missing",
          logLevel: "info",
          maxSlackResponseChars: 3500,
        },
      },
    },
  ])("rejects $label", ({ change }) => {
    const { config } = fixture();
    expect(() => parseArk(productConfigType, { ...config, ...change }, "config")).toThrow(
      "config is invalid",
    );
  });

  it("requires private secret-file permissions without rewriting the file", () => {
    const { paths } = fixture();
    writeFileSync(
      paths.secretsFile,
      "SLACK_BOT_TOKEN=xoxb-synthetic\nSLACK_APP_TOKEN=xapp-synthetic\n",
      { mode: 0o600 },
    );
    chmodSync(paths.secretsFile, 0o644);
    const before = readFileSync(paths.secretsFile, "utf8");
    expect(() => readProductSecrets(paths)).toThrow("permissions 0600");
    expect(readFileSync(paths.secretsFile, "utf8")).toBe(before);
  });

  it("honors every explicitly configured native Codex home", () => {
    expect(effectiveCodexHome(undefined)).toBeUndefined();
    expect(effectiveCodexHome("/synthetic/codex-profile")).toBe("/synthetic/codex-profile");
  });
});

describe("Slack image safety", () => {
  it("accepts only the supported Slack image metadata and enforces the count limit", () => {
    expect(
      parseSlackImages([
        {
          id: "F1",
          mimetype: "image/png",
          name: "screen.png",
          size: 1024,
          url_private_download: "https://files.slack.com/screen.png",
        },
      ]),
    ).toHaveLength(1);
    expect(() =>
      parseSlackImages(
        Array.from({ length: 5 }, (_, index) => ({
          id: `F${index}`,
          mimetype: "image/png",
          name: `${index}.png`,
          size: 1,
          url_private_download: `https://files.slack.com/${index}.png`,
        })),
      ),
    ).toThrow(/at most 4/u);
  });

  it("downloads verified images into private temporary files and cleans them up", async () => {
    const files = parseSlackImages([
      {
        id: "F1",
        mimetype: "image/png",
        name: "screen.png",
        size: 8,
        url_private_download: "https://files.slack.com/screen.png",
      },
    ]);
    const batch = await downloadSlackImages(files, "xoxb-test", async () => {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        status: 200,
      });
    });
    const imagePath = batch.paths[0];
    if (imagePath === undefined) {
      throw new Error("Expected a downloaded image path");
    }
    expect(statSync(path.dirname(imagePath)).mode & 0o777).toBe(0o700);
    expect(statSync(imagePath).mode & 0o777).toBe(0o600);
    await batch.cleanup();
    expect(existsSync(imagePath)).toBe(false);
  });
});

describe("LaunchAgent generation", () => {
  it("uses the setup Node executable and preserves the terminal PATH and home", () => {
    const { directory: root } = fixture();
    const plist = launchAgentPlist(
      productPaths(root),
      "/opt/node",
      "/app/dist/index.js",
      "/app",
      "/opt/homebrew/bin:/usr/bin:/bin",
      "/synthetic/home",
    );
    expect(plist).toContain("<string>/opt/node</string>");
    expect(plist).toContain("<string>/app/dist/index.js</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/app</string>");
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
    expect(plist).toContain(
      "<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>",
    );
    expect(plist).toContain("<key>HOME</key>\n    <string>/synthetic/home</string>");
    expect(plist).toContain(root);
    expect(plist).toContain("bridge.error.log");
  });
});
