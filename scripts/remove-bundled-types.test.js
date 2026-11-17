import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pacote from "pacote";
import {
    createCachedTypesMetadata,
    createNpmFetch,
    findRemovals,
    hasBundledTypes,
    main,
    pullRequestBody,
    runCli,
} from "./remove-bundled-types.js";

/**
 * @param {string} path
 * @param {unknown} value
 */
function writeJson(path, value) {
    writeFileSync(path, JSON.stringify(value, undefined, 4) + "\n");
}

/**
 * @param {import("node:test").TestContext} t
 * @param {Record<string, Record<string, unknown>>} packages
 */
function fixture(t, packages) {
    const root = mkdtempSync(join(tmpdir(), "dt-bundled-types-"));
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }));
    mkdirSync(join(root, "scripts"));
    copyFileSync(new URL("not-needed.js", import.meta.url), join(root, "scripts", "not-needed.js"));
    writeFileSync(join(root, ".gitignore"), ".test-state/\n");
    writeJson(join(root, ".test-plan.json"), {});
    writeFileSync(
        join(root, "scripts", "pnpm.cjs"),
        `
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const args = process.argv.slice(2);
fs.mkdirSync(".test-state", { recursive: true });
fs.appendFileSync(".test-state/commands.jsonl", JSON.stringify({
    args,
    head: cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
}) + "\\n");
if (args[0] === "install") process.exit(0);
if (args[0] !== "run") throw new Error("Unexpected pnpm arguments: " + args.join(" "));
const script = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts[args[1]];
if (!script) throw new Error("Missing script: " + args[1]);
let result;
if (args[1] === "not-needed" && script !== "node scripts/not-needed.js") {
    result = cp.spawnSync(script, { shell: true, stdio: "inherit" });
} else {
    const file = args[1] === "not-needed" ? "not-needed.js" : "test-dt.cjs";
    result = cp.spawnSync(process.execPath, [path.join("scripts", file), ...args.slice(2)], { stdio: "inherit" });
}
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
`,
    );
    writeFileSync(
        join(root, "scripts", "test-dt.cjs"),
        `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const args = process.argv.slice(2);
assert.equal(args[args.indexOf("--selection") + 1], "affected");
assert.equal(args[args.indexOf("--diffBase") + 1], "HEAD");
const report = args[args.indexOf("--writeFailures") + 1];
assert.ok(report);
const previous = JSON.parse(cp.execFileSync("git", ["show", "HEAD:notNeededPackages.json"], { encoding: "utf8" })).packages;
const current = JSON.parse(fs.readFileSync("notNeededPackages.json", "utf8")).packages;
const removed = Object.keys(current).filter(name => !(name in previous));
assert.equal(removed.length, 1);
assert.equal(fs.existsSync(path.join("types", removed[0])), false);
const plan = JSON.parse(fs.readFileSync(".test-plan.json", "utf8"))[removed[0]] || {};
if (plan.noReport) process.exit(1);
if (plan.malformedReport) {
    fs.writeFileSync(report, "not JSON");
    process.exit(1);
}
const pins = Object.entries(plan.pins || {});
const pinned = pins.length > 0 && pins.every(([packagePath, version]) => {
    const metadata = JSON.parse(fs.readFileSync(path.join("types", packagePath, "package.json"), "utf8"));
    const specs = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
        .map(group => metadata[group]?.["@types/" + removed[0]]).filter(spec => spec !== undefined);
    return specs.length > 0 && specs.every(spec => spec === version);
});
const failures = (plan.alwaysFail || (plan.failures && !pinned) ? plan.failures : []) || [];
fs.writeFileSync(report, JSON.stringify(failures.map(packagePath => ({ path: packagePath, error: "Downstream type error" }))));
process.exit(failures.length ? 1 : 0);
`,
    );
    writeJson(join(root, "package.json"), {
        private: true,
        type: "module",
        scripts: { "not-needed": "node scripts/not-needed.js", "test-all": "node scripts/test-dt.cjs" },
    });
    writeJson(join(root, "notNeededPackages.json"), {
        packages: { "already-removed": { libraryName: "already-removed", asOfVersion: "1.0.0" } },
    });
    writeJson(join(root, "attw.json"), {
        failingPackages: [...Object.keys(packages).flatMap(name => [name, `${name}/v1`]), "firstXtest"],
    });
    mkdirSync(join(root, "types"));
    for (const [name, metadata] of Object.entries(packages)) {
        const directory = join(root, "types", name);
        mkdirSync(join(directory, "v1"), { recursive: true });
        writeJson(join(directory, "package.json"), { name: `@types/${name}`, version: "1.0.9999", ...metadata });
        writeJson(join(directory, "v1", "package.json"), { name: `@types/${name}`, version: "0.1.9999" });
        writeFileSync(join(directory, "index.d.ts"), "export const example: string;\n");
    }
    return root;
}

/**
 * @param {string} root
 * @param {typeof fetch} fetcher
 */
function runRemoval(root, fetcher) {
    return main(root, fetcher, join(root, "scripts", "pnpm.cjs"));
}

/**
 * @param {string} root
 * @returns {{ args: string[]; head: string }[]}
 */
function commands(root) {
    return readFileSync(join(root, ".test-state", "commands.jsonl"), "utf8").trim().split("\n").map(line =>
        JSON.parse(line)
    );
}

/**
 * @param {string} root
 * @param {string[]} args
 */
function git(root, ...args) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** @param {string} root */
function initializeGit(root) {
    git(root, "init", "--initial-branch=master");
    git(root, "config", "user.name", "typescript-automation[bot]");
    git(root, "config", "user.email", "290192711+typescript-automation[bot]@users.noreply.github.com");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "core.autocrlf", "false");
    git(root, "add", ".");
    git(
        root,
        "commit",
        "-m",
        "Fixture",
        "-m",
        "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    );
    return git(root, "rev-parse", "HEAD");
}

/** @param {RequestInfo | URL} input */
function requestUrl(input) {
    return input instanceof Request ? input.url : String(input);
}

/** @param {Record<string, unknown>} responses */
function mockRegistry(responses) {
    /** @type {string[]} */
    const requests = [];
    /** @type {typeof fetch} */
    const fetcher = async (input, options) => {
        const url = requestUrl(input);
        requests.push(url);
        const headers = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined));
        assert.equal(headers.get("accept"), "application/json");
        assert.ok(Object.hasOwn(responses, url), `Unexpected request: ${url}`);
        const response = responses[url];
        return response instanceof Response ? response.clone() : Response.json(response);
    };
    return { fetcher, requests };
}

/**
 * @param {string} name
 * @param {{ version?: string; downloads?: number; versions?: string[]; tags?: Record<string, string>; manifest?: Record<string, unknown>; files?: string[] }} options
 * @returns {Record<string, unknown>}
 */
function npmResponses(
    name,
    {
        version = "2.0.0",
        downloads = 100,
        versions = ["1.0.0"],
        tags = {},
        manifest = {},
        files = ["index.js", "index.d.ts"],
    } = {},
) {
    const library = name.includes("__") ? `@${name.replace("__", "/")}` : name;
    return {
        [`https://registry.npmjs.org/${encodeURIComponent(library)}/latest`]: {
            name: library,
            version,
            types: "index.d.ts",
            ...manifest,
        },
        [`https://api.npmjs.org/downloads/point/last-month/@types/${name}`]: { downloads },
        [`https://registry.npmjs.org/${encodeURIComponent(`@types/${name}`)}`]: {
            versions: Object.fromEntries(versions.map(published => [published, {}])),
            "dist-tags": tags,
        },
        [`https://unpkg.com/${library}@${version}/?meta`]: {
            package: library,
            version,
            prefix: "/",
            files: ["package.json", ...files].map(path => ({ path: `/${path}` })),
        },
    };
}

test("paces concurrent download requests to three per minute without pacing registry metadata", async () => {
    let now = 0;
    /** @type {{ url: string; time: number }[]} */
    const starts = [];
    /** @type {number[]} */
    const delays = [];
    const client = createNpmFetch(
        async input => {
            starts.push({ url: requestUrl(input), time: now });
            return Response.json({ downloads: 0 });
        },
        async ms => {
            delays.push(ms);
            now += ms;
        },
        () => now,
    );
    await Promise.all([
        client("https://api.npmjs.org/downloads/point/last-month/@types/first"),
        client("https://registry.npmjs.org/first/latest"),
        client("https://api.npmjs.org/downloads/point/last-month/@types/second"),
        client("https://api.npmjs.org/downloads/point/last-month/@types/third"),
        client("https://api.npmjs.org/downloads/point/last-month/@types/fourth"),
    ]);
    assert.deepEqual(starts.filter(start => start.url.startsWith("https://api.npmjs.org/")).map(start => start.time), [
        0,
        20_000,
        40_000,
        60_000,
    ]);
    assert.equal(starts.find(start => start.url.startsWith("https://registry.npmjs.org/"))?.time, 0);
    assert.deepEqual(delays, [20_000, 20_000, 20_000]);
});

test("paces download retries even when Retry-After requests an immediate retry", async () => {
    let now = 0;
    /** @type {number[]} */
    const starts = [];
    const client = createNpmFetch(
        async () => {
            starts.push(now);
            return starts.length === 1
                ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
                : Response.json({ downloads: 0 });
        },
        async ms => {
            now += ms;
        },
        () => now,
    );
    assert.equal((await client("https://api.npmjs.org/downloads/point/last-month/@types/first")).status, 200);
    assert.deepEqual(starts, [0, 20_000]);
});

test("shares download Retry-After cooldowns with queued requests without blocking registry metadata", async context => {
    const date = Date.UTC(2030, 0, 1);
    context.mock.method(Date, "now", () => date);
    for (const retryAfter of ["120", new Date(date + 120_000).toUTCString()]) {
        await context.test(retryAfter, async () => {
            let now = 0;
            let attempts = 0;
            /** @type {{ url: string; time: number }[]} */
            const starts = [];
            const client = createNpmFetch(
                async input => {
                    const url = requestUrl(input);
                    starts.push({ url, time: now });
                    return url.endsWith("/first") && attempts++ === 0
                        ? new Response(null, { status: 429, headers: { "Retry-After": retryAfter } })
                        : Response.json({ downloads: 0 });
                },
                async ms => {
                    now += ms;
                },
                () => now,
            );
            await Promise.all([
                client("https://api.npmjs.org/downloads/point/last-month/@types/first"),
                client("https://api.npmjs.org/downloads/point/last-month/@types/second"),
                client("https://registry.npmjs.org/first/latest"),
            ]);
            const downloads = starts.filter(start => start.url.startsWith("https://api.npmjs.org/"));
            assert.equal(downloads.length, 3);
            assert.equal(downloads[0].time, 0);
            assert.ok(downloads[1].time >= 120_000);
            assert.ok(downloads[2].time - downloads[1].time >= 20_000);
            assert.equal(starts.find(start => start.url.startsWith("https://registry.npmjs.org/"))?.time, 0);
        });
    }
});

test("keeps the shared download cooldown when the rate-limited caller aborts", async () => {
    let now = 0;
    /** @type {number[]} */
    const starts = [];
    const controller = new AbortController();
    const client = createNpmFetch(
        async () => {
            starts.push(now);
            return starts.length === 1
                ? new Response(null, { status: 429, headers: { "Retry-After": "120" } })
                : Response.json({ downloads: 0 });
        },
        async (ms, signal) => {
            if (signal === controller.signal) {
                controller.abort();
                signal.throwIfAborted();
            }
            now += ms;
        },
        () => now,
    );
    await assert.rejects(
        client("https://api.npmjs.org/downloads/point/last-month/@types/first", {
            signal: controller.signal,
        }),
        { name: "AbortError" },
    );
    await client("https://api.npmjs.org/downloads/point/last-month/@types/second");
    assert.deepEqual(starts, [0, 120_000]);
});

test("native fetch honors Retry-After seconds and dates with a fresh timeout for each attempt", async t => {
    const now = Date.UTC(2030, 0, 1);
    t.mock.method(Date, "now", () => now);
    for (
        const { status, date } of [
            { status: 429, date: false },
            { status: 429, date: true },
            { status: 503, date: false },
        ]
    ) {
        await t.test(`${status}, ${date ? "HTTP date" : "seconds"}`, async () => {
            /** @type {AbortSignal[]} */
            const signals = [];
            /** @type {number[]} */
            const delays = [];
            const client = createNpmFetch(
                async (_input, options) => {
                    assert.ok(options?.signal);
                    signals.push(options.signal);
                    if (signals.length === 1) {
                        return new Response(null, {
                            status,
                            headers: { "Retry-After": date ? new Date(now + 60_000).toUTCString() : "1" },
                        });
                    }
                    return Response.json({ ok: true });
                },
                async ms => {
                    delays.push(ms);
                },
            );
            assert.deepEqual(await (await client("https://registry.npmjs.org/limited")).json(), { ok: true });
            assert.deepEqual(delays, [date ? 60_000 : 1_000]);
            assert.equal(signals.length, 2);
            assert.notEqual(signals[0], signals[1]);
        });
    }
});

test("native fetch waits for Retry-After over a real HTTP connection", async t => {
    /** @type {number[]} */
    const attempts = [];
    const server = createServer((_request, response) => {
        attempts.push(performance.now());
        if (attempts.length === 1) {
            response.writeHead(429, { "Retry-After": "1" });
            response.end("Rate limited");
        } else {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ ok: true }));
        }
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve(undefined));
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(undefined);
        });
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await createNpmFetch()(`http://127.0.0.1:${address.port}/limited`);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(attempts.length, 2);
    assert.ok(attempts[1] - attempts[0] >= 1_000);
});

test("retries every endpoint, including npm downloads and UNPKG metadata", async t => {
    const root = fixture(t, { implicit: {} });
    const { fetcher, requests } = mockRegistry(npmResponses("implicit", { manifest: { types: undefined } }));
    /** @type {Map<string, number>} */
    const attempts = new Map();
    const client = createNpmFetch(
        async (input, options) => {
            const url = requestUrl(input);
            const count = (attempts.get(url) ?? 0) + 1;
            attempts.set(url, count);
            if (count === 1) {
                return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
            }
            return fetcher(input, options);
        },
        async () => {},
    );
    assert.deepEqual(await findRemovals(root, client), [
        { typingsPackageName: "implicit", libraryName: "implicit", asOfVersion: "2.0.0" },
    ]);
    assert.equal(attempts.size, 4);
    assert.ok([...attempts.values()].every(count => count === 2));
    assert.equal(requests.length, 4);
});

test("bounds native HTTP retries and applies exponential backoff with jitter", async () => {
    for (const status of [429, 503, 400]) {
        let attempts = 0;
        /** @type {number[]} */
        const delays = [];
        const client = createNpmFetch(
            async () => {
                attempts++;
                return Response.json({ error: "Unavailable" }, { status });
            },
            async ms => {
                delays.push(ms);
            },
        );
        assert.equal((await client("https://registry.npmjs.org/unavailable")).status, status);
        assert.equal(attempts, status === 400 ? 1 : 6);
        assert.equal(delays.length, status === 400 ? 0 : 5);
        for (const [index, delay] of delays.entries()) {
            assert.ok(delay >= 500 * 2 ** index && delay <= 1_000 * 2 ** index);
        }
    }
});

test("does not retry unsafe methods, network exceptions, or aborted requests", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const client = createNpmFetch(
        async () => {
            attempts++;
            return new Response(null, { status: 429 });
        },
        async () => controller.abort(),
    );
    assert.equal((await client("https://registry.npmjs.org/write", { method: "POST" })).status, 429);
    assert.equal(attempts, 1);
    await assert.rejects(client("https://registry.npmjs.org/read", { signal: controller.signal }), {
        name: "AbortError",
    });
    assert.equal(attempts, 2);

    let networkAttempts = 0;
    const unavailable = createNpmFetch(async () => {
        networkAttempts++;
        throw new TypeError("Network unavailable");
    });
    await assert.rejects(unavailable("https://registry.npmjs.org/unavailable"), /Network unavailable/);
    assert.equal(networkAttempts, 1);
});

test("rejects excessive Retry-After delays rather than overflowing the timer and retrying early", async () => {
    const client = createNpmFetch(async () =>
        new Response(null, {
            status: 429,
            headers: { "Retry-After": "999999999999999999999999" },
        })
    );
    await assert.rejects(client("https://registry.npmjs.org/limited"), /supported timer duration/);
});

test("preserves not-found metadata skips when using the retrying client", async t => {
    const root = fixture(t, { missing: {} });
    let attempts = 0;
    const client = createNpmFetch(async () => {
        attempts++;
        return new Response(null, { status: 404 });
    });
    assert.deepEqual(await findRemovals(root, client), []);
    assert.equal(attempts, 1);
});

test("resolves explicit types and typings only when the referenced files are shipped", () => {
    for (
        const manifest of [
            { types: "./declarations/entry.d.ts" },
            { types: "declarations/entry" },
            { typings: "./declarations/entry.d.mts" },
        ]
    ) {
        assert.equal(
            hasBundledTypes("library", manifest, [
                "package.json",
                "declarations/entry.d.ts",
                "declarations/entry.d.mts",
            ]),
            true,
        );
    }
    for (
        const manifest of [
            {},
            { types: false },
            { types: "" },
            { types: " ", typings: null },
            { types: "./not-shipped.d.ts" },
            { typesVersions: { "*": { "*": ["index.d.ts"] } } },
        ]
    ) {
        assert.equal(hasBundledTypes("library", manifest, ["package.json", "index.js"]), false);
    }
});

test("recognizes root type exports without mistaking a typed subpath for a typed package", () => {
    for (
        const exports of [
            "./index.d.ts",
            { types: "./index.d.ts", default: "./index.js" },
            { ".": { types: "./index.d.ts", default: "./index.js" } },
            { ".": { import: { types: "./index.d.mts" }, require: { types: "./index.d.cts" } } },
            { ".": { "types@>=5.2": "./index.d.ts" } },
        ]
    ) {
        assert.equal(
            hasBundledTypes("library", { exports }, ["package.json", "index.d.ts", "index.d.mts", "index.d.cts"]),
            true,
        );
    }
    for (
        const exports of [
            "./index.js",
            null,
            { types: null },
            { types: "" },
            { "./typed-subpath": { types: "./subpath.d.ts" } },
            { ".": "./index.js", "./typed-subpath": { types: "./subpath.d.ts" } },
        ]
    ) {
        assert.equal(hasBundledTypes("library", { exports }, ["package.json", "index.js", "subpath.d.ts"]), false);
    }
});

test("resolves implicit declarations beside default, main, and conditional export entry points", () => {
    for (
        const { manifest, files } of [
            { manifest: {}, files: ["index.js", "index.d.ts"] },
            { manifest: { main: "lib/main.js" }, files: ["lib/main.js", "lib/main.d.ts"] },
            { manifest: { main: "lib/main" }, files: ["lib/main.js", "lib/main.d.ts"] },
            { manifest: { main: "lib" }, files: ["lib/index.js", "lib/index.d.ts"] },
            { manifest: { main: "lib/main.mjs" }, files: ["lib/main.mjs", "lib/main.d.mts"] },
            { manifest: { main: "lib/main.cjs" }, files: ["lib/main.cjs", "lib/main.d.cts"] },
            { manifest: { exports: "./dist/main.js" }, files: ["dist/main.js", "dist/main.d.ts"] },
            {
                manifest: { exports: { ".": { import: "./dist/main.mjs", require: "./dist/main.cjs" } } },
                files: ["dist/main.mjs", "dist/main.d.mts", "dist/main.cjs", "dist/main.d.cts"],
            },
            { manifest: { types: "./src/main.ts" }, files: ["src/main.ts"] },
        ]
    ) {
        assert.equal(hasBundledTypes("@scope/library", manifest, ["package.json", ...files]), true);
    }
    assert.equal(
        hasBundledTypes("library", { main: "index.js" }, ["package.json", "index.js", "test/fixture.d.ts"]),
        false,
    );
});

test("discovers implicit types from UNPKG file lists, not package.json file whitelists", async t => {
    const root = fixture(t, { implicit: {}, main: {}, whitelist: {}, fixture: {} });
    const { fetcher, requests } = mockRegistry({
        ...npmResponses("implicit", { manifest: { types: undefined } }),
        ...npmResponses("main", {
            manifest: { types: undefined, main: "dist/main.js" },
            files: ["dist/main.js", "dist/main.d.ts"],
        }),
        ...npmResponses("whitelist", { manifest: { types: undefined, files: ["index.d.ts"] }, files: ["index.js"] }),
        ...npmResponses("fixture", { manifest: { types: undefined }, files: ["index.js", "test/fixture.d.ts"] }),
    });
    assert.deepEqual(await findRemovals(root, fetcher), [
        { typingsPackageName: "implicit", libraryName: "implicit", asOfVersion: "2.0.0" },
        { typingsPackageName: "main", libraryName: "main", asOfVersion: "2.0.0" },
    ]);
    assert.equal(requests.filter(url => url.startsWith("https://unpkg.com/")).length, 4);
    assert.ok(requests.every(url => !url.endsWith(".tgz")));
});

test("finds unscoped and scoped packages, skipping non-npm declarations and old version directories", async t => {
    const root = fixture(t, {
        first: {},
        scope__second: {},
        browser: { nonNpm: true },
        node: { nonNpm: "conflict" },
    });
    mkdirSync(join(root, "types", "without-metadata"));
    const { fetcher, requests } = mockRegistry({ ...npmResponses("first"), ...npmResponses("scope__second") });
    assert.deepEqual(await findRemovals(root, fetcher), [
        { typingsPackageName: "first", libraryName: "first", asOfVersion: "2.0.0" },
        { typingsPackageName: "scope__second", libraryName: "@scope/second", asOfVersion: "2.0.0" },
    ]);
    assert.equal(requests.length, 8);
    assert.ok(requests.includes("https://registry.npmjs.org/%40scope%2Fsecond/latest"));
    assert.ok(requests.includes("https://api.npmjs.org/downloads/point/last-month/@types/scope__second"));
    assert.ok(requests.includes("https://unpkg.com/first@2.0.0/?meta"));
    assert.ok(requests.includes("https://unpkg.com/@scope/second@2.0.0/?meta"));
});

test("partitions packages exactly once across twenty shards and keeps assignments stable when packages are added", async t => {
    const shardCount = 20;
    const names = Array.from({ length: 23 }, (_, index) => `package-${String(index).padStart(2, "0")}`);
    const root = fixture(t, {
        ...Object.fromEntries(names.map(name => [name, {}])),
        browser: { nonNpm: true },
    });
    const { fetcher, requests } = mockRegistry(
        Object.assign({}, npmResponses("aaa-new-package"), ...names.map(name => npmResponses(name))),
    );
    const shards = [];
    const assignments = new Map();
    for (let shardIndex = 0; shardIndex < shardCount; shardIndex++) {
        const removals = await findRemovals(root, fetcher, { shardIndex, shardCount });
        for (const removal of removals) {
            assignments.set(removal.typingsPackageName, shardIndex);
        }
        shards.push(...removals.map(removal => removal.typingsPackageName));
    }
    assert.deepEqual(shards.sort(), names);
    assert.equal(new Set(requests).size, requests.length);

    mkdirSync(join(root, "types", "aaa-new-package"));
    writeJson(join(root, "types", "aaa-new-package", "package.json"), { name: "@types/aaa-new-package" });
    let added = 0;
    for (let shardIndex = 0; shardIndex < shardCount; shardIndex++) {
        const removals = await findRemovals(root, fetcher, { shardIndex, shardCount });
        for (const removal of removals) {
            if (removal.typingsPackageName === "aaa-new-package") {
                added++;
            } else {
                assert.equal(assignments.get(removal.typingsPackageName), shardIndex);
            }
        }
    }
    assert.equal(added, 1);
});

test("rejects invalid shard indices and counts before querying npm", async t => {
    const root = fixture(t, { first: {} });
    const { fetcher, requests } = mockRegistry({});
    for (
        const options of [
            { shardCount: 0 },
            { shardCount: 1.5 },
            { shardIndex: -1 },
            { shardIndex: 1, shardCount: 1 },
            { shardIndex: 0.5 },
        ]
    ) {
        await assert.rejects(findRemovals(root, fetcher, options), /shardIndex < shardCount/);
    }
    assert.deepEqual(requests, []);
});

test("scans without changing the checkout and combines shards into one revalidated removal run", async t => {
    const root = fixture(t, { first: {}, second: {}, unrelated: {} });
    const commit = initializeGit(root);
    const { fetcher, requests } = mockRegistry({
        ...npmResponses("first"),
        ...npmResponses("second"),
        ...npmResponses("unrelated", { files: ["index.js"] }),
    });
    const directory = join(root, ".test-state", "candidates");
    mkdirSync(directory, { recursive: true });
    for (let shardIndex = 0; shardIndex < 2; shardIndex++) {
        const result = await runCli(
            [
                "--scan",
                "--shard-index",
                String(shardIndex),
                "--shard-count",
                "2",
            ],
            root,
            fetcher,
        );
        assert.ok(result);
        const scan = JSON.parse(result);
        assert.equal(scan.commit, commit);
        assert.equal(scan.shardIndex, shardIndex);
        assert.equal(scan.shardCount, 2);
        writeJson(join(directory, `${shardIndex}.json`), scan);
    }
    assert.equal(git(root, "rev-parse", "HEAD"), commit);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(existsSync(join(root, ".test-state", "commands.jsonl")), false);

    const checkedBefore = requests.length;
    const body = await runCli(["--candidates", directory], root, fetcher, join(root, "scripts", "pnpm.cjs"));
    assert.ok(body);
    assert.ok(body.includes("This run removes **2** declaration packages."));
    assert.equal(git(root, "rev-list", "--count", `${commit}..HEAD`), "2");
    assert.ok(requests.slice(checkedBefore).every(url => !url.includes("unrelated")));
    assert.equal(requests.slice(checkedBefore).filter(url => url.includes("/downloads/")).length, 2);
});

test("runs only a single shard's candidates when partial results are explicitly allowed", async t => {
    const root = fixture(t, { first: {}, untouched: {} });
    const commit = initializeGit(root);
    const directory = join(root, ".test-state", "candidates");
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "0.json"), { commit, shardIndex: 0, shardCount: 20, packages: ["first"] });
    const { fetcher } = mockRegistry(npmResponses("first"));
    await assert.rejects(runCli(["--candidates", directory], root, fetcher), /Missing scan shard results/);
    const body = await runCli(
        ["--candidates", directory, "--allow-partial"],
        root,
        fetcher,
        join(root, "scripts", "pnpm.cjs"),
    );
    assert.ok(body);
    assert.ok(body.includes("This run removes **1** declaration packages."));
    assert.equal(existsSync(join(root, "types", "first")), false);
    assert.equal(existsSync(join(root, "types", "untouched")), true);
    assert.equal(git(root, "rev-list", "--count", `${commit}..HEAD`), "1");
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("rejects empty candidate paths before querying npm or mutating the checkout", async context => {
    const root = fixture(context, { first: {}, unrelated: {} });
    const commit = initializeGit(root);
    const { fetcher, requests } = mockRegistry({});
    for (
        const args of [
            ["--candidates="],
            ["--candidates", ""],
            ["--candidates", " \t "],
            ["--scan", "--candidates="],
            ["--candidates=", "--allow-partial"],
        ]
    ) {
        await assert.rejects(runCli(args, root, fetcher), /--candidates requires a non-empty directory path/);
    }
    assert.deepEqual(requests, []);
    assert.equal(git(root, "rev-parse", "HEAD"), commit);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(existsSync(join(root, ".test-state", "commands.jsonl")), false);
});

test("requires a candidates directory when allowing partial scan results", async () => {
    await assert.rejects(runCli(["--allow-partial"]), /--allow-partial requires --candidates/);
});

test("rejects incomplete, inconsistent, or stale scan artifacts before querying npm", async t => {
    const root = fixture(t, { first: {} });
    const commit = initializeGit(root);
    const directory = join(root, ".test-state", "candidates");
    mkdirSync(directory, { recursive: true });
    const { fetcher, requests } = mockRegistry({});
    const first = { commit, shardIndex: 0, shardCount: 2, packages: ["first"] };
    const second = { commit, shardIndex: 1, shardCount: 2, packages: [] };
    for (
        const scans of [
            [],
            [first],
            [first, first],
            [first, { ...second, shardCount: 3 }],
            [first, { ...second, commit: "different-commit" }],
            [first, { ...second, packages: ["first"] }],
            [first, { ...second, packages: ["../outside"] }],
        ]
    ) {
        for (const name of ["0.json", "1.json"]) {
            rmSync(join(directory, name), { force: true });
        }
        scans.forEach((scan, index) => writeJson(join(directory, `${index}.json`), scan));
        await assert.rejects(runCli(["--candidates", directory], root, fetcher), /scan|Duplicate package/);
        if (scans.length === 2) {
            await assert.rejects(
                runCli(["--candidates", directory, "--allow-partial"], root, fetcher),
                /scan|Duplicate package/,
            );
        }
    }
    assert.deepEqual(requests, []);
    assert.equal(git(root, "rev-parse", "HEAD"), commit);
});

test("does not remove scan candidates whose published @types versions have advanced", async t => {
    const root = fixture(t, { first: {} });
    const commit = initializeGit(root);
    const directory = join(root, ".test-state", "candidates");
    mkdirSync(directory, { recursive: true });
    writeJson(join(directory, "0.json"), { commit, shardIndex: 0, shardCount: 1, packages: ["first"] });
    const { fetcher } = mockRegistry(npmResponses("first", { versions: ["1.0.0", "3.0.0"] }));
    assert.equal(await runCli(["--candidates", directory], root, fetcher), undefined);
    assert.equal(git(root, "rev-parse", "HEAD"), commit);
    assert.equal(existsSync(join(root, "types", "first")), true);
});

test("uses a shared scan progress marker for cache, retry, and skip messages and resets it afterward", async context => {
    const root = fixture(context, { first: {}, second: {} });
    const logger = context.mock.method(console, "error", () => {});
    const readTypesMetadata = createCachedTypesMetadata("unused", async (name, options) => {
        if (options.offline) {
            throw Object.assign(new Error("Not cached"), { code: "ENOTCACHED" });
        }
        if (name === "@types/first") {
            throw Object.assign(new Error("Not found"), { code: "E404" });
        }
        return { versions: { "3.0.0": {} } };
    });
    const { fetcher } = mockRegistry({ ...npmResponses("first"), ...npmResponses("second") });
    let retried = false;
    const client = createNpmFetch(async (input, options) => {
        if (requestUrl(input) === "https://registry.npmjs.org/second/latest" && !retried) {
            retried = true;
            return new Response(null, { status: 503, headers: { "Retry-After": "0" } });
        }
        return fetcher(input, options);
    }, async () => {});
    assert.deepEqual(await findRemovals(root, client, { readTypesMetadata }), []);
    const lines = logger.mock.calls.map(call => String(call.arguments[0]));
    assert.ok(lines.includes("[1/2] Checking @types/first"));
    assert.ok(lines.includes("[2/2] Checking @types/second"));
    assert.ok(lines.includes("[1/2] Fetching uncached npm metadata for @types/first"));
    assert.ok(lines.includes("[2/2] Fetching uncached npm metadata for @types/second"));
    assert.ok(lines.includes("[1/2] Skipping unavailable npm metadata: @types/first"));
    assert.ok(lines.includes("[2/2] Retrying https://registry.npmjs.org/second/latest in 0ms (retry 1/5, HTTP 503)"));
    assert.ok(lines.includes("[2/2] Skipping second@2.0.0: not newer than every published @types/second version"));
    await readTypesMetadata("@types/outside-scan");
    assert.equal(logger.mock.calls.at(-1)?.arguments[0], "Fetching uncached npm metadata for @types/outside-scan");
    await assert.rejects(
        findRemovals(root, async () => {
            throw new Error("Scan failed");
        }),
        /Scan failed/,
    );
    await readTypesMetadata("@types/after-failure");
    assert.equal(logger.mock.calls.at(-1)?.arguments[0], "Fetching uncached npm metadata for @types/after-failure");
});

test("scans packages serially and numbers progress after package filtering", async context => {
    const names = Array.from({ length: 12 }, (_, index) => `package-${String(index).padStart(2, "0")}`);
    const root = fixture(context, {
        ...Object.fromEntries(names.map(name => [name, {}])),
        browser: { nonNpm: true },
    });
    const logger = context.mock.method(console, "error", () => {});
    const { fetcher } = mockRegistry(
        Object.assign({}, ...names.map(name => npmResponses(name, { version: "2.0.0-beta.1" }))),
    );
    assert.deepEqual(await findRemovals(root, fetcher), []);
    const lines = logger.mock.calls.map(call => String(call.arguments[0]));
    assert.deepEqual(
        lines.slice(1),
        names.flatMap((name, index) => [
            `[${index + 1}/${names.length}] Checking @types/${name}`,
            `[${index + 1}/${names.length}] Skipping ${name}: latest is a prerelease (2.0.0-beta.1)`,
        ]),
    );
});

test("populates and reuses the publisher-compatible full-metadata cache without requesting cached @types metadata", async t => {
    const root = fixture(t, { first: {} });
    const cache = join(root, ".test-state", "pacote-cache");
    let metadataRequests = 0;
    const server = createServer((request, response) => {
        metadataRequests++;
        const name = decodeURIComponent(request.url?.slice(1) ?? "");
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "public, max-age=0");
        if (name === "@types/missing") {
            response.writeHead(404);
            response.end(JSON.stringify({ error: "Not found" }));
        } else {
            assert.equal(name, "@types/first");
            response.end(JSON.stringify({ name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } }));
        }
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve(undefined));
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve(undefined);
        });
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const registry = `http://127.0.0.1:${address.port}`;
    const { fetcher, requests } = mockRegistry(npmResponses("first"));
    for (let run = 0; run < 2; run++) {
        const readTypesMetadata = createCachedTypesMetadata(
            cache,
            (name, options) => pacote.packument(name, { ...options, registry }),
        );
        assert.deepEqual(await findRemovals(root, fetcher, { readTypesMetadata }), [
            { typingsPackageName: "first", libraryName: "first", asOfVersion: "2.0.0" },
        ]);
    }
    assert.equal(metadataRequests, 1);
    assert.equal(requests.length, 6);
    assert.ok(!requests.includes("https://registry.npmjs.org/%40types%2Ffirst"));
    assert.equal(requests.filter(url => url.includes("/downloads/")).length, 2);
    const readTypesMetadata = createCachedTypesMetadata(
        cache,
        (name, options) => pacote.packument(name, { ...options, registry }),
    );
    assert.equal(await readTypesMetadata("@types/missing"), undefined);
    assert.equal(metadataRequests, 2);
});

test("does not mistake cache errors for misses or malformed metadata for usable cache entries", async () => {
    const failure = Object.assign(new Error("Cache unreadable"), { code: "EACCES" });
    const unreadable = createCachedTypesMetadata("unused", async () => {
        throw failure;
    });
    await assert.rejects(unreadable("@types/first"), failure);
    const malformed = createCachedTypesMetadata("unused", async () => []);
    await assert.rejects(malformed("@types/first"), /Invalid cached npm metadata/);
});

test("uses the strict mergebot popularity boundary, excluding Popular and Critical packages", async t => {
    const counts = [0, 199_999, 200_000, 200_001, 5_000_000, 5_000_001];
    const root = fixture(t, Object.fromEntries(counts.map(downloads => [`downloads-${downloads}`, {}])));
    const { fetcher, requests } = mockRegistry(Object.assign(
        {},
        ...counts.map(downloads => npmResponses(`downloads-${downloads}`, { downloads })),
    ));
    assert.deepEqual(
        (await findRemovals(root, fetcher)).map(removal => removal.typingsPackageName).sort(),
        ["downloads-0", "downloads-199999", "downloads-200000"],
    );
    for (const downloads of [200_001, 5_000_000, 5_000_001]) {
        assert.ok(!requests.includes(`https://registry.npmjs.org/%40types%2Fdownloads-${downloads}`));
    }
    assert.equal(requests.filter(url => url.startsWith("https://unpkg.com/")).length, 3);
});

test("only retires stable latest releases newer than all published @types versions", async t => {
    const root = fixture(t, { eligible: {}, equal: {}, newer: {}, prerelease: {}, untyped: {} });
    const { fetcher } = mockRegistry({
        ...npmResponses("eligible", { version: "2.0.0", versions: ["1.9.9", "2.0.0-beta.1"] }),
        ...npmResponses("equal", { version: "2.0.0", versions: ["2.0.0"] }),
        ...npmResponses("newer", { version: "2.0.0", versions: ["1.0.0", "3.0.0"] }),
        ...npmResponses("prerelease", { version: "3.0.0-beta.1" }),
        ...npmResponses("untyped", { manifest: { types: undefined }, files: ["index.js"] }),
    });
    assert.deepEqual(await findRemovals(root, fetcher), [
        { typingsPackageName: "eligible", libraryName: "eligible", asOfVersion: "2.0.0" },
    ]);
});

test("does not retire packages whose bundled types depend on their @types package", async t => {
    const root = fixture(t, { dependency: {}, optional: {}, peer: {}, development: {} });
    const { fetcher } = mockRegistry({
        ...npmResponses("dependency", { manifest: { dependencies: { "@types/dependency": "*" } } }),
        ...npmResponses("optional", { manifest: { optionalDependencies: { "@types/optional": "*" } } }),
        ...npmResponses("peer", { manifest: { peerDependencies: { "@types/peer": "*" } } }),
        ...npmResponses("development", { manifest: { devDependencies: { "@types/development": "*" } } }),
    });
    assert.deepEqual(await findRemovals(root, fetcher), [
        { typingsPackageName: "development", libraryName: "development", asOfVersion: "2.0.0" },
    ]);
});

test("skips missing library, download, or @types metadata rather than assuming zero downloads", async t => {
    const root = fixture(t, { missing: {}, downloads: {}, typings: {} });
    const { fetcher } = mockRegistry({
        ...npmResponses("missing"),
        ...npmResponses("downloads"),
        ...npmResponses("typings"),
        "https://registry.npmjs.org/missing/latest": new Response(null, { status: 404 }),
        "https://api.npmjs.org/downloads/point/last-month/@types/downloads": new Response(null, { status: 404 }),
        "https://registry.npmjs.org/%40types%2Ftypings": new Response(null, { status: 404 }),
    });
    assert.deepEqual(await findRemovals(root, fetcher), []);
});

test("rejects failed requests and malformed registry data", async t => {
    for (
        const [url, response, error] of [
            ["https://registry.npmjs.org/invalid/latest", new Response(null, { status: 429 }), /Request failed \(429/],
            ["https://registry.npmjs.org/invalid/latest", [], /Expected an object/],
            [
                "https://registry.npmjs.org/invalid/latest",
                { types: "index.d.ts", version: "bad" },
                /Invalid npm version/,
            ],
            ["https://api.npmjs.org/downloads/point/last-month/@types/invalid", {}, /Invalid monthly download count/],
            [
                "https://api.npmjs.org/downloads/point/last-month/@types/invalid",
                { downloads: -1 },
                /Invalid monthly download count/,
            ],
            ["https://registry.npmjs.org/%40types%2Finvalid", { versions: {} }, /Missing published versions/],
            ["https://registry.npmjs.org/%40types%2Finvalid", { versions: { bad: {} } }, /Invalid published versions/],
        ]
    ) {
        const root = fixture(t, { invalid: {} });
        const { fetcher } = mockRegistry({ ...npmResponses("invalid"), [String(url)]: response });
        assert.ok(error instanceof RegExp);
        await assert.rejects(findRemovals(root, fetcher), error);
    }
});

test("skips unavailable UNPKG metadata and empty file lists", async t => {
    const root = fixture(t, { missing: {}, empty: {} });
    const { fetcher } = mockRegistry({
        ...npmResponses("missing"),
        ...npmResponses("empty", { files: [] }),
        "https://unpkg.com/missing@2.0.0/?meta": new Response(null, { status: 404 }),
        "https://unpkg.com/empty@2.0.0/?meta": { package: "empty", version: "2.0.0", prefix: "/", files: [] },
    });
    assert.deepEqual(await findRemovals(root, fetcher), []);
});

test("rejects failed, malformed, or mismatched UNPKG metadata", async t => {
    const url = "https://unpkg.com/invalid@2.0.0/?meta";
    const metadata = { package: "invalid", version: "2.0.0", prefix: "/", files: [{ path: "/index.d.ts" }] };
    for (
        const [response, error] of [
            [new Response(null, { status: 503 }), /Request failed \(503/],
            [new Response(null), /Missing JSON response body/],
            [new Response("not JSON"), /JSON|Unexpected token/],
            [[], /Expected an object/],
            [{}, /Invalid UNPKG metadata/],
            [{ ...metadata, package: "different" }, /Invalid UNPKG metadata/],
            [{ ...metadata, version: "3.0.0" }, /Invalid UNPKG metadata/],
            [{ ...metadata, prefix: "/dist/" }, /Invalid UNPKG metadata/],
            [{ ...metadata, files: {} }, /Invalid UNPKG metadata/],
            [{ ...metadata, files: [null] }, /Invalid UNPKG metadata/],
            [{ ...metadata, files: [{ path: 0 }] }, /Invalid UNPKG metadata/],
            [{ ...metadata, files: [{ path: "index.d.ts" }] }, /Invalid UNPKG metadata/],
        ]
    ) {
        const root = fixture(t, { invalid: {} });
        const { fetcher } = mockRegistry({ ...npmResponses("invalid"), [url]: response });
        assert.ok(error instanceof RegExp);
        await assert.rejects(findRemovals(root, fetcher), error);
    }
});

test("creates one real not-needed commit per removal and a combined inline PR body", async t => {
    const root = fixture(t, { "first.test": {}, scope__second: {}, keep: { nonNpm: true } });
    assert.equal(existsSync(join(root, ".github", "PULL_REQUEST_TEMPLATE.md")), false);
    const base = initializeGit(root);
    const { fetcher } = mockRegistry({
        ...npmResponses("first.test"),
        ...npmResponses("scope__second", {
            manifest: { types: undefined, main: "dist/second.js" },
            files: ["dist/second.js", "dist/second.d.ts"],
        }),
    });
    const body = await runRemoval(root, fetcher);

    assert.equal(existsSync(join(root, "types", "first.test")), false);
    assert.equal(existsSync(join(root, "types", "scope__second")), false);
    assert.equal(existsSync(join(root, "types", "keep")), true);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "notNeededPackages.json"), "utf8")), {
        packages: {
            "already-removed": { libraryName: "already-removed", asOfVersion: "1.0.0" },
            "first.test": { libraryName: "first.test", asOfVersion: "2.0.0" },
            scope__second: { libraryName: "@scope/second", asOfVersion: "2.0.0" },
        },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(root, "attw.json"), "utf8")).failingPackages, [
        "keep",
        "keep/v1",
        "firstXtest",
    ]);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(git(root, "rev-list", "--count", `${base}..HEAD`), "2");
    assert.deepEqual(git(root, "log", "--reverse", "--format=%s", `${base}..HEAD`).split("\n"), [
        "Remove @types/first.test; first.test now bundles types",
        "Remove @types/scope__second; @scope/second now bundles types",
    ]);
    const commits = git(root, "rev-list", "--reverse", `${base}..HEAD`).split("\n");
    const testRuns = commands(root).filter(command => command.args[1] === "test-all");
    assert.equal(testRuns.length, 2);
    assert.deepEqual(testRuns.map(command => command.head), [base, commits[0]]);
    for (const command of testRuns) {
        assert.deepEqual(command.args.slice(0, 6), [
            "run",
            "test-all",
            "--selection",
            "affected",
            "--diffBase",
            "HEAD",
        ]);
        assert.equal(existsSync(command.args[7]), false);
    }
    for (const [index, name] of ["first.test", "scope__second"].entries()) {
        assert.deepEqual(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", commits[index]).split("\n"), [
            "attw.json",
            "notNeededPackages.json",
            `types/${name}/index.d.ts`,
            `types/${name}/package.json`,
            `types/${name}/v1/package.json`,
        ]);
    }
    assert.ok(body);
    assert.match(body, /`pnpm run not-needed first\.test 2\.0\.0` - passed/);
    assert.match(body, /`pnpm run not-needed scope__second 2\.0\.0 @scope\/second` - passed/);
    assert.match(body, /`pnpm run test-all --selection affected --diffBase HEAD --writeFailures .+` - passed/);
});

test("pins only failing downstream packages, preserves ranges and legacy versions, and retests before committing", async t => {
    const root = fixture(t, {
        first: {},
        consumer: {
            nonNpm: true,
            dependencies: { "@types/first": "*", "@types/unrelated": "*" },
            devDependencies: { "@types/first": " known " },
            peerDependencies: { "@types/first": "^1.0.0" },
        },
        unaffected: { nonNpm: true, dependencies: { "@types/first": "*" } },
    });
    const legacy = join(root, "types", "consumer", "v1", "package.json");
    writeJson(legacy, { name: "@types/consumer", version: "0.1.9999", dependencies: { "@types/first": "^0.5.0" } });
    writeJson(join(root, ".test-plan.json"), {
        first: {
            failures: ["consumer", "consumer/v1"],
            pins: { consumer: "1.5.0", "consumer/v1": "0.5.2" },
        },
    });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry(npmResponses("first", {
        versions: ["0.5.2", "1.0.0", "1.5.0"],
        tags: { known: "1.5.0" },
    }));
    assert.ok(await runRemoval(root, fetcher));

    const consumer = JSON.parse(readFileSync(join(root, "types", "consumer", "package.json"), "utf8"));
    assert.deepEqual(consumer.dependencies, { "@types/first": "1.5.0", "@types/unrelated": "*" });
    assert.equal(consumer.devDependencies["@types/first"], "1.5.0");
    assert.equal(consumer.peerDependencies["@types/first"], "1.5.0");
    assert.equal(JSON.parse(readFileSync(legacy, "utf8")).dependencies["@types/first"], "0.5.2");
    assert.equal(
        JSON.parse(readFileSync(join(root, "types", "unaffected", "package.json"), "utf8"))
            .dependencies["@types/first"],
        "*",
    );
    const executed = commands(root);
    assert.deepEqual(executed.map(command => command.args.slice(0, 2)), [
        ["run", "not-needed"],
        ["install"],
        ["run", "test-all"],
        ["install"],
        ["run", "test-all"],
    ]);
    assert.ok(executed.every(command => command.head === base));
    assert.equal(git(root, "rev-list", "--count", `${base}..HEAD`), "1");
    const committedFiles = git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
    assert.ok(committedFiles.includes("types/consumer/package.json"));
    assert.ok(committedFiles.includes("types/consumer/v1/package.json"));
    assert.ok(!committedFiles.includes("types/unaffected/package.json"));
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("undoes a still-failing removal and its pins, then continues with the next package", async t => {
    const root = fixture(t, {
        first: {},
        second: {},
        consumer: { nonNpm: true, dependencies: { "@types/first": "*" } },
    });
    writeJson(join(root, ".test-plan.json"), {
        first: { failures: ["consumer"], pins: { consumer: "1.0.0" }, alwaysFail: true },
    });
    const consumerPath = join(root, "types", "consumer", "package.json");
    const originalConsumer = readFileSync(consumerPath, "utf8");
    const base = initializeGit(root);
    const { fetcher } = mockRegistry({ ...npmResponses("first"), ...npmResponses("second") });
    const body = await runRemoval(root, fetcher);

    assert.equal(existsSync(join(root, "types", "first", "index.d.ts")), true);
    assert.equal(existsSync(join(root, "types", "first", "v1", "package.json")), true);
    assert.equal(existsSync(join(root, "types", "second")), false);
    assert.equal(readFileSync(consumerPath, "utf8"), originalConsumer);
    const notNeeded = JSON.parse(readFileSync(join(root, "notNeededPackages.json"), "utf8")).packages;
    assert.equal(notNeeded.first, undefined);
    assert.equal(notNeeded.second.asOfVersion, "2.0.0");
    const attw = JSON.parse(readFileSync(join(root, "attw.json"), "utf8")).failingPackages;
    assert.ok(attw.includes("first") && attw.includes("first/v1") && !attw.includes("second"));
    assert.equal(git(root, "rev-list", "--count", `${base}..HEAD`), "1");
    assert.equal(git(root, "log", "-1", "--format=%s"), "Remove @types/second; second now bundles types");
    assert.equal(commands(root).filter(command => command.args[1] === "test-all").length, 3);
    assert.ok(body);
    assert.ok(body.includes("This run removes **1** declaration packages."));
    assert.ok(body.includes("`@types/second`:"));
    assert.ok(!body.includes("`@types/first`:"));
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("makes no PR or commit when downstream tests still fail after pinning", async t => {
    const root = fixture(t, {
        first: {},
        consumer: { nonNpm: true, dependencies: { "@types/first": "*" } },
    });
    writeJson(join(root, ".test-plan.json"), {
        first: { failures: ["consumer"], pins: { consumer: "1.0.0" }, alwaysFail: true },
    });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry(npmResponses("first"));
    assert.equal(await runRemoval(root, fetcher), undefined);
    assert.equal(git(root, "rev-parse", "HEAD"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(commands(root).filter(command => command.args[1] === "test-all").length, 2);
});

test("does not replace an incompatible downstream range with an arbitrary published version", async t => {
    const root = fixture(t, {
        first: {},
        consumer: { nonNpm: true, dependencies: { "@types/first": "^9.0.0" } },
    });
    writeJson(join(root, ".test-plan.json"), { first: { failures: ["consumer"], alwaysFail: true } });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry(npmResponses("first"));
    assert.equal(await runRemoval(root, fetcher), undefined);
    assert.equal(git(root, "rev-parse", "HEAD"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("retries DT validation failures without package results, then rolls back and skips", async t => {
    const root = fixture(t, { first: {} });
    writeJson(join(root, ".test-plan.json"), { first: { noReport: true } });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry(npmResponses("first"));
    assert.equal(await runRemoval(root, fetcher), undefined);
    assert.equal(git(root, "rev-parse", "HEAD"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(commands(root).filter(command => command.args[1] === "test-all").length, 2);
});

test("rolls back malformed test results without undoing earlier successful removal commits", async t => {
    const root = fixture(t, { first: {}, second: {} });
    writeJson(join(root, ".test-plan.json"), { second: { malformedReport: true } });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry({ ...npmResponses("first"), ...npmResponses("second") });
    await assert.rejects(runRemoval(root, fetcher), SyntaxError);
    assert.equal(git(root, "rev-list", "--count", `${base}..HEAD`), "1");
    assert.equal(existsSync(join(root, "types", "first")), false);
    assert.equal(existsSync(join(root, "types", "second", "index.d.ts")), true);
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("keeps a large batch in one PR without exceeding GitHub's body limit", () => {
    const removals = Array.from({ length: 1_000 }, (_, index) => ({
        typingsPackageName: `package-${index}`,
        libraryName: `package-${index}`,
        asOfVersion: "2.0.0",
        testCommand: "pnpm run test-all --selection affected --diffBase HEAD --writeFailures report.json",
    }));
    const body = pullRequestBody(removals);
    assert.ok(body.length < 65_536);
    assert.ok(body.includes("This run removes **1000** declaration packages."));
    const listed = body.match(/^- `@types\//gm)?.length ?? 0;
    const omitted = body.match(/^- (\d+) additional removals are included in individual commits/m);
    assert.ok(omitted);
    assert.equal(listed + Number(omitted[1]), removals.length);
    assert.ok(body.includes("`pnpm run not-needed package-0 2.0.0` - passed"));
});

test("uses the JavaScript pnpm entry point supplied through npm_execpath", async t => {
    const root = fixture(t, { first: {} });
    const pnpmPath = process.env.npm_execpath;
    const base = initializeGit(root);
    const { fetcher } = mockRegistry(npmResponses("first"));
    process.env.npm_execpath = join(root, "scripts", "pnpm.cjs");
    try {
        assert.ok(await main(root, fetcher));
    } finally {
        if (pnpmPath === undefined) {
            delete process.env.npm_execpath;
        } else {
            process.env.npm_execpath = pnpmPath;
        }
    }
    assert.equal(git(root, "rev-list", "--count", `${base}..HEAD`), "1");
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("propagates not-needed failures without creating a commit or returning a PR body", async t => {
    const root = fixture(t, { first: {} });
    writeJson(join(root, "package.json"), {
        private: true,
        scripts: { "not-needed": "node -e \"process.exit(1)\"" },
    });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry(npmResponses("first"));
    await assert.rejects(runRemoval(root, fetcher), /Command failed/);
    assert.equal(git(root, "rev-parse", "HEAD"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("makes no commits and produces no PR body when no removals are found", async t => {
    const root = fixture(t, { untyped: {} });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry(npmResponses("untyped", { manifest: { types: undefined }, files: ["index.js"] }));
    assert.equal(await runRemoval(root, fetcher), undefined);
    assert.equal(git(root, "rev-parse", "HEAD"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
});

test("rejects dirty working trees before querying npm", async t => {
    const root = fixture(t, { first: {} });
    initializeGit(root);
    writeFileSync(join(root, "unrelated.txt"), "Do not commit this file.\n");
    const { fetcher, requests } = mockRegistry({});
    await assert.rejects(runRemoval(root, fetcher), /requires a clean working tree/);
    assert.deepEqual(requests, []);
});

test("completes discovery before making any changes, so registry failures leave the checkout untouched", async t => {
    const root = fixture(t, { eligible: {}, unavailable: {} });
    const base = initializeGit(root);
    const { fetcher } = mockRegistry({
        ...npmResponses("eligible"),
        "https://registry.npmjs.org/unavailable/latest": new Response(null, { status: 503 }),
    });
    await assert.rejects(runRemoval(root, fetcher), /Request failed \(503/);
    assert.equal(git(root, "rev-parse", "HEAD"), base);
    assert.equal(git(root, "status", "--porcelain"), "");
    assert.equal(existsSync(join(root, "types", "eligible")), true);
});
