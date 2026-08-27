import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { describe, expect, it } from "vitest";
import { FALLBACK_MODEL_ITEMS } from "../src/cursor-fallback-models.generated.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
	version: string;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	bundledDependencies?: string[];
	overrides?: Record<string, string>;
};
const packageLock = require("../package-lock.json") as {
	version: string;
	packages: Record<string, { version?: string; dependencies?: Record<string, string>; bundleDependencies?: boolean | string[] }>;
};

function lockPackageVersion(packageName: string): string | undefined {
	return packageLock.packages[`node_modules/${packageName}`]?.version;
}

function packageIdentitiesFromTarListing(listing: string): Set<string> {
	const identities = new Set<string>();
	for (const line of listing.split(/\r?\n/)) {
		const match = line.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/);
		if (match?.[1]) identities.add(match[1]);
	}
	return identities;
}

function npmPack(args: string[], cwd: string): string {
	// `bun run` sets npm_execpath to the bun binary, which has no `pack`
	// subcommand. Only honor an npm_execpath that actually looks like npm.
	const npmCli = process.env.npm_execpath;
	const npmCliBasename = npmCli ? npmCli.split(/[\\/]/).pop() ?? "" : "";
	const isRealNpmCli = npmCliBasename === "npm" || npmCliBasename === "npm.cmd" || npmCliBasename === "npm-cli.js";
	return npmCli && isRealNpmCli
		? execFileSync(process.execPath, [npmCli, ...args], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			})
		: execFileSync("npm", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				shell: process.platform === "win32",
			});
}

describe("package metadata cutover baselines", () => {
	it("keeps package, lockfile, and changelog release versions aligned", () => {
		const changelogVersion = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8").match(/^## (\S+) /m)?.[1];

		expect(packageLock.version).toBe(packageJson.version);
		expect(packageLock.packages[""]?.version).toBe(packageJson.version);
		expect(changelogVersion).toBe(packageJson.version);
	});

	it("pins and installs Cursor SDK exactly", () => {
		expect(packageJson.dependencies["@cursor/sdk"]).toBe("1.0.27");
		const installedSdk = JSON.parse(
			readFileSync(join(process.cwd(), "node_modules/@cursor/sdk/package.json"), "utf8"),
		) as { version?: string };
		expect(installedSdk.version).toBe("1.0.27");
	});

	it("keeps MCP/Hono as ordinary runtime dependencies for Bun git installs", () => {
		expect(packageJson.dependencies["@modelcontextprotocol/sdk"]).toBe("1.30.0");
		expect(lockPackageVersion("@modelcontextprotocol/sdk")).toBe("1.30.0");
		expect(packageJson.dependencies["@hono/node-server"]).toBe("2.0.12");
		expect(lockPackageVersion("@hono/node-server")).toBe("2.0.12");
		expect(packageJson.bundledDependencies).toBeUndefined();
	});

	it("resolves the exact bridge runtime imports from installed dependencies", () => {
		expect(require.resolve("@modelcontextprotocol/sdk/server/index.js")).toContain("@modelcontextprotocol");
		expect(require.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js")).toContain("@modelcontextprotocol");
		expect(require.resolve("@hono/node-server")).toContain("@hono");
	});

	it("keeps local agent ID policy aligned with the installed public string contract", () => {
		const sdkOptions = readFileSync(join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/options.d.ts"), "utf8");

		expect(sdkOptions).toMatch(/export interface AgentOptions[\s\S]*?\bagentId\?: string;/);
	});

	it("pins the Node ConnectRPC transport required by Cursor SDK's Node seam", () => {
		const sdkTransportDts = readFileSync(
			join(process.cwd(), "node_modules/@cursor/sdk/dist/esm/transport.d.ts"),
			"utf8",
		);

		expect(sdkTransportDts).toContain("Node");
		expect(sdkTransportDts).toContain("`@connectrpc/connect-node`");
		expect(packageLock.packages["node_modules/@cursor/sdk"]?.dependencies?.["@connectrpc/connect-node"]).toBe("^1.6.1");
		expect(packageJson.dependencies["@connectrpc/connect-node"]).toBeUndefined();
		expect(lockPackageVersion("@connectrpc/connect-node")).toBe("1.7.0");
	});

	it("keeps installed ConnectRPC transport siblings aligned", () => {
		expect(lockPackageVersion("@connectrpc/connect-node")).toBe("1.7.0");
		expect(lockPackageVersion("@connectrpc/connect-web")).toBe("1.7.0");
	});

	it("leaves the Cursor SDK transport dependency tree to package-manager resolution", () => {
		expect(packageJson.dependencies.undici).toBeUndefined();
		expect(packageJson.bundledDependencies).toBeUndefined();
		expect(packageJson.overrides).toBeUndefined();
		expect(packageLock.packages["node_modules/@connectrpc/connect-node/node_modules/undici"]?.version).toBe("5.29.0");
	});

	it("removes the obsolete sqlite override", () => {
		expect(packageJson.overrides).toBeUndefined();
	});

	it("packs MCP/Hono as dependencies, not falsely bundled payloads", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "omp-cursor-sdk-runtime-deps-"));
		try {
			const packOutput = npmPack(["pack", "--ignore-scripts", "--pack-destination", tempRoot], process.cwd());
			const tarballName = packOutput.trim().split(/\r?\n/).at(-1)?.trim();
			expect(tarballName).toMatch(/^omp-cursor-sdk-.*\.tgz$/);

			const listing = execFileSync("tar", ["-tzf", tarballName!], { cwd: tempRoot, encoding: "utf8" });
			expect(listing).toContain("package/package.json");
			const packedIdentities = packageIdentitiesFromTarListing(listing);
			expect(packedIdentities.has("@modelcontextprotocol/sdk")).toBe(false);
			expect(packedIdentities.has("@hono/node-server")).toBe(false);
			expect(packedIdentities.has("@cursor/sdk")).toBe(false);

			const extractDirName = "extract";
			const extractDir = join(tempRoot, extractDirName);
			mkdirSync(extractDir);
			execFileSync("tar", ["-xzf", tarballName!, "-C", extractDirName], { cwd: tempRoot });

			const packedPackageJson = JSON.parse(readFileSync(join(extractDir, "package", "package.json"), "utf8")) as {
				bundledDependencies?: string[];
				dependencies?: Record<string, string>;
			};
			expect(packedPackageJson.bundledDependencies).toBeUndefined();
			expect(packedPackageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBe("1.30.0");
			expect(packedPackageJson.dependencies?.["@hono/node-server"]).toBe("2.0.12");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}, 60_000);

	it("tracks OMP openai-codex GPT-5.6 metadata", () => {
		for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
			expect(getBundledModel("openai-codex", modelId)).toMatchObject({
				contextWindow: 372000,
				maxTokens: 128000,
			});
		}
	});

	it("keeps Grok UX examples aligned with the generated Cursor catalog", () => {
		const spec = readFileSync(join(process.cwd(), "docs/cursor-model-ux-spec.md"), "utf8");
		const grok = FALLBACK_MODEL_ITEMS.find((item) => item.id === "grok-4.5");

		expect(grok?.parameters?.map((parameter) => parameter.id)).toEqual(["effort", "fast"]);
		expect(FALLBACK_MODEL_ITEMS.some((item) => item.id === "grok-4.3")).toBe(false);
		expect(spec).toContain("### `grok-4.5`");
		expect(spec).not.toContain("grok-4.3");
	});
});
