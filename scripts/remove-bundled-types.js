import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { json } from "node:stream/consumers";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pacote from "pacote";
import { gt, lt, maxSatisfying, prerelease, valid, validRange } from "semver";
import ts from "typescript";

// Popular and Critical packages both exceed this limit:
// https://github.com/microsoft/DefinitelyTyped-tools/blob/a014cafa97b565021d8013e4721e8245ef3ded5e/packages/mergebot/src/pr-info.ts#L750
const maxMonthlyDownloads = 200_000;
const root = fileURLToPath(new URL("../", import.meta.url));
let packageProgress = "";

/** @param {string} message */
function logPackage(message) {
    console.error(`${packageProgress}${message}`);
}

/**
 * @param {typeof fetch} fetcher
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} wait
 * @param {() => number} now
 * @returns {typeof fetch}
 */
export function createNpmFetch(
    fetcher = fetch,
    wait = (ms, signal) => setTimeout(ms, undefined, { signal }),
    now = () => performance.now(),
) {
    let downloadQueue = Promise.resolve();
    let lastDownloadRequest = -Infinity;
    let downloadCooldownUntil = -Infinity;
    return async (input, options) => {
        const url = input instanceof Request ? input.url : String(input);
        const parsedUrl = new URL(url);
        const isDownloadRequest = parsedUrl.origin === "https://api.npmjs.org"
            && parsedUrl.pathname.startsWith("/downloads/");
        const method = (options?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
        const retryableStatuses = [408, 429, 500, 502, 503, 504];
        for (let attempt = 0;; attempt++) {
            signal?.throwIfAborted();
            const request = async () => {
                signal?.throwIfAborted();
                if (isDownloadRequest) {
                    const delay = Math.max(lastDownloadRequest + 20_000, downloadCooldownUntil) - now();
                    if (delay > 0) {
                        await wait(delay, signal ?? undefined);
                    }
                    signal?.throwIfAborted();
                    lastDownloadRequest = now();
                }
                const timeout = AbortSignal.timeout(30_000);
                const response = await fetcher(input, {
                    ...options,
                    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                });
                if (!["GET", "HEAD"].includes(method) || !retryableStatuses.includes(response.status)) {
                    return { response };
                }
                const retryAfter = response.headers.get("retry-after")?.trim();
                const requestedDelay = retryAfter === undefined
                    ? NaN
                    : /^\d+$/.test(retryAfter)
                    ? Number(retryAfter) * 1_000
                    : Date.parse(retryAfter) - Date.now();
                if (requestedDelay > 2_147_483_647) {
                    throw new Error(`Retry-After exceeds the supported timer duration: ${url}`);
                }
                const delay = Number.isFinite(requestedDelay)
                    ? Math.max(0, requestedDelay)
                    : Math.ceil(Math.min(60_000, 1_000 * 2 ** attempt) * (0.5 + Math.random() / 2));
                if (isDownloadRequest) {
                    downloadCooldownUntil = Math.max(downloadCooldownUntil, now() + delay);
                }
                if (attempt === 5) {
                    return { response };
                }
                await response.body?.cancel();
                return { response, delay };
            };
            const pending = isDownloadRequest ? downloadQueue.then(request) : request();
            if (isDownloadRequest) {
                downloadQueue = pending.then(() => {}, () => {});
            }
            const { response, delay } = await pending;
            if (delay === undefined) {
                return response;
            }
            logPackage(`Retrying ${url} in ${delay}ms (retry ${attempt + 1}/5, HTTP ${response.status})`);
            await wait(delay, signal ?? undefined);
        }
    };
}

export const npmFetch = createNpmFetch();

/**
 * @typedef {{ typingsPackageName: string; libraryName: string; asOfVersion: string }} Removal
 * @typedef {Removal & { testCommand: string }} TestedRemoval
 * @typedef {{ path: string; error: string }} TestFailure
 * @typedef {(name: string) => Promise<Record<string, unknown> | undefined>} TypesMetadataReader
 * @typedef {{ shardIndex?: number; shardCount?: number; packageNames?: readonly string[]; readTypesMetadata?: TypesMetadataReader }} ScanOptions
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} typings
 * @param {string} typesName
 */
function publishedVersions(typings, typesName) {
    if (!isRecord(typings.versions) || !Object.keys(typings.versions).length) {
        throw new Error(`Missing published versions for ${typesName}`);
    }
    const versions = Object.keys(typings.versions);
    if (versions.some(version => !valid(version))) {
        throw new Error(`Invalid published versions for ${typesName}`);
    }
    return versions;
}

/**
 * @param {string} libraryName
 * @param {Record<string, unknown>} manifest
 * @param {readonly string[]} fileNames
 */
export function hasBundledTypes(libraryName, manifest, fileNames) {
    const packageRoot = `/node_modules/${libraryName}/`;
    const files = new Set(fileNames.map(name => packageRoot + name));
    const packageJson = JSON.stringify(manifest);
    /** @type {import("typescript").ModuleResolutionHost} */
    const host = {
        fileExists: path => files.has(path),
        readFile: path => path === `${packageRoot}package.json` ? packageJson : undefined,
    };
    /** @type {import("typescript").ResolutionMode[]} */
    const resolutionModes = [ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS];
    // Let TypeScript find both explicit types and implicit declarations beside entry points.
    return resolutionModes.some(mode => {
        const { resolvedModule } = ts.resolveModuleName(
            libraryName,
            "/index.ts",
            { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
            host,
            undefined,
            undefined,
            mode,
        );
        return resolvedModule !== undefined && /\.(?:[cm]?ts|tsx)$/.test(resolvedModule.resolvedFileName);
    });
}

/**
 * @param {string} url
 * @param {typeof fetch} fetcher
 * @param {boolean} skipServerErrors
 */
async function fetchJson(url, fetcher, skipServerErrors = false) {
    const response = await fetcher(url, {
        headers: { accept: "application/json" },
    });
    if (response.status === 404 || (skipServerErrors && response.status >= 500 && response.status < 600)) {
        logPackage(`Skipping unavailable metadata (HTTP ${response.status}): ${url}`);
        await response.body?.cancel();
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`Request failed (${response.status} ${response.statusText}): ${url}`);
    }
    if (!response.body) {
        throw new Error(`Missing JSON response body: ${url}`);
    }
    const result = await json(Readable.from(response.body, { signal: AbortSignal.timeout(30_000) }));
    if (!isRecord(result)) {
        throw new Error(`Expected an object from ${url}`);
    }
    return result;
}

/**
 * @param {string} cache
 * @param {(name: string, options: { cache: string; fullMetadata: true; offline?: boolean; preferOnline?: boolean }) => Promise<unknown>} readPackument
 * @returns {TypesMetadataReader}
 */
export function createCachedTypesMetadata(cache, readPackument = pacote.packument) {
    return async name => {
        const metadata = await readPackument(name, { cache, fullMetadata: true, offline: true }).catch(error => {
            if (!isRecord(error) || error.code !== "ENOTCACHED") {
                throw error;
            }
            logPackage(`Fetching uncached npm metadata for ${name}`);
            return readPackument(name, { cache, fullMetadata: true, preferOnline: true });
        }).catch(error => {
            if (!isRecord(error) || error.code !== "E404") {
                throw error;
            }
            logPackage(`Skipping unavailable npm metadata: ${name}`);
            return undefined;
        });
        if (metadata !== undefined && !isRecord(metadata)) {
            throw new Error(`Invalid cached npm metadata for ${name}`);
        }
        return metadata;
    };
}

/**
 * @param {string} libraryName
 * @param {string} version
 * @param {typeof fetch} fetcher
 */
async function getPackageFiles(libraryName, version, fetcher) {
    const metadata = await fetchJson(`https://unpkg.com/${libraryName}@${version}/?meta`, fetcher, true);
    if (!metadata) {
        return undefined;
    }
    if (
        metadata.package !== libraryName || metadata.version !== version || metadata.prefix !== "/"
        || !Array.isArray(metadata.files)
        || !metadata.files.every(file => isRecord(file) && typeof file.path === "string" && file.path.startsWith("/"))
    ) {
        throw new Error(`Invalid UNPKG metadata for ${libraryName}@${version}`);
    }
    return metadata.files.map(file => file.path.slice(1));
}

/**
 * @param {string} typingsPackageName
 * @param {typeof fetch} fetcher
 * @param {TypesMetadataReader | undefined} readTypesMetadata
 * @returns {Promise<Removal | undefined>}
 */
async function findRemoval(typingsPackageName, fetcher, readTypesMetadata) {
    const libraryName = typingsPackageName.includes("__")
        ? `@${typingsPackageName.replace("__", "/")}`
        : typingsPackageName;
    const manifest = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(libraryName)}/latest`, fetcher);
    if (!manifest) {
        return undefined;
    }
    const asOfVersion = manifest.version;
    if (typeof asOfVersion !== "string" || !valid(asOfVersion)) {
        throw new Error(`Invalid npm version for ${libraryName}: ${asOfVersion}`);
    }
    if (prerelease(asOfVersion)) {
        logPackage(`Skipping ${libraryName}: latest is a prerelease (${asOfVersion})`);
        return undefined;
    }

    const typesName = `@types/${typingsPackageName}`;
    if (
        [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].some(dependencies =>
            isRecord(dependencies) && Object.hasOwn(dependencies, typesName)
        )
    ) {
        logPackage(`Skipping ${libraryName}: its bundled types still depend on ${typesName}`);
        return undefined;
    }

    const downloads = await fetchJson(`https://api.npmjs.org/downloads/point/last-month/${typesName}`, fetcher);
    if (!downloads) {
        return undefined;
    }
    if (
        typeof downloads.downloads !== "number" || !Number.isSafeInteger(downloads.downloads)
        || downloads.downloads < 0
    ) {
        throw new Error(`Invalid monthly download count for ${typesName}`);
    }
    if (downloads.downloads > maxMonthlyDownloads) {
        logPackage(`Skipping Popular or Critical package ${typesName} (${downloads.downloads} monthly downloads)`);
        return undefined;
    }

    const typings = readTypesMetadata
        ? await readTypesMetadata(typesName)
        : await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(typesName)}`, fetcher);
    if (!typings) {
        return undefined;
    }
    const versions = publishedVersions(typings, typesName);
    if (versions.some(version => !gt(asOfVersion, version))) {
        logPackage(`Skipping ${libraryName}@${asOfVersion}: not newer than every published ${typesName} version`);
        return undefined;
    }
    const files = await getPackageFiles(libraryName, asOfVersion, fetcher);
    if (!files || !hasBundledTypes(libraryName, manifest, files)) {
        return undefined;
    }

    return { typingsPackageName, libraryName, asOfVersion };
}

/**
 * @param {string} repoRoot
 * @param {typeof fetch} fetcher
 * @param {ScanOptions} options
 */
export async function findRemovals(
    repoRoot,
    fetcher = npmFetch,
    { shardIndex = 0, shardCount = 1, packageNames: includedNames, readTypesMetadata } = {},
) {
    if (
        !Number.isSafeInteger(shardCount) || shardCount < 1
        || !Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount
    ) {
        throw new Error("Expected 0 <= shardIndex < shardCount with a positive integer shardCount");
    }
    const packageNames = readdirSync(join(repoRoot, "types"), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(repoRoot, "types", entry.name, "package.json")))
        .map(entry => entry.name)
        .sort()
        .filter(name => {
            const metadata = JSON.parse(readFileSync(join(repoRoot, "types", name, "package.json"), "utf8"));
            return !metadata.nonNpm && (!includedNames || includedNames.includes(name));
        })
        .filter(name => createHash("sha256").update(name).digest().readUInt32BE(0) % shardCount === shardIndex);

    console.error(
        `Checking ${packageNames.length} npm-backed packages for bundled types (shard ${
            shardIndex + 1
        }/${shardCount})...`,
    );
    /** @type {Removal[]} */
    const removals = [];
    try {
        for (const [index, name] of packageNames.entries()) {
            packageProgress = `[${index + 1}/${packageNames.length}] `;
            logPackage(`Checking @types/${name}`);
            const removal = await findRemoval(name, fetcher, readTypesMetadata);
            if (removal) {
                removals.push(removal);
            }
        }
    } finally {
        packageProgress = "";
    }
    return removals;
}

/**
 * @param {Removal} removal
 */
function notNeededArgs({ typingsPackageName, asOfVersion, libraryName }) {
    return [
        "run",
        "not-needed",
        typingsPackageName,
        asOfVersion,
        ...(libraryName === typingsPackageName ? [] : [libraryName]),
    ];
}

/**
 * @param {string} repoRoot
 * @param {string} pnpmPath
 * @param {string[]} args
 * @param {boolean} allowFailure
 */
function runPnpm(repoRoot, pnpmPath, args, allowFailure = false) {
    const isJavaScript = /\.[cm]?js$/i.test(pnpmPath);
    console.error(`Running: pnpm ${args.join(" ")}`);
    const result = spawnSync(
        isJavaScript ? process.execPath : pnpmPath,
        [...(isJavaScript ? [pnpmPath] : []), ...args],
        { cwd: repoRoot, stdio: ["ignore", 2, 2] },
    );
    if (result.error) {
        throw result.error;
    }
    if (result.status === null) {
        throw new Error(`pnpm ${args.join(" ")} terminated with signal ${result.signal}`);
    }
    if (result.status !== 0) {
        const message = `Command failed (${result.status}): pnpm ${args.join(" ")}`;
        if (!allowFailure) {
            throw new Error(message);
        }
        console.error(message);
    }
    return result.status === 0;
}

/**
 * @param {string} repoRoot
 * @param {string} pnpmPath
 * @param {string} reportPath
 */
function runAffectedTests(repoRoot, pnpmPath, reportPath) {
    rmSync(reportPath, { force: true });
    const args = ["run", "test-all", "--selection", "affected", "--diffBase", "HEAD", "--writeFailures", reportPath];
    const passed = runPnpm(repoRoot, pnpmPath, args, true);
    const command = ["pnpm", ...args].map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(" ");
    if (!existsSync(reportPath)) {
        if (passed) {
            throw new Error("DT tests exited successfully without writing their failure report");
        }
        console.error("DT validation failed before reporting individual package failures");
        return { passed: false, failures: [], command };
    }
    /** @type {unknown} */
    const failures = JSON.parse(readFileSync(reportPath, "utf8"));
    if (
        !Array.isArray(failures)
        || !failures.every(failure =>
            isRecord(failure) && typeof failure.path === "string" && typeof failure.error === "string"
        )
    ) {
        throw new Error("Invalid DT test failure report");
    }
    if (passed && failures.length) {
        console.error("DT tests reported failures despite exiting successfully");
    }
    return { passed: passed && failures.length === 0, failures, command };
}

/**
 * @param {string} repoRoot
 * @param {TestFailure[]} failures
 * @param {Removal} removal
 * @param {typeof fetch} fetcher
 */
async function dependencyPins(repoRoot, failures, removal, fetcher) {
    const typesRoot = resolve(repoRoot, "types");
    const typesName = `@types/${removal.typingsPackageName}`;
    const groups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    const manifests = [...new Set(failures.map(failure => failure.path))].map(path => {
        const file = resolve(typesRoot, path, "package.json");
        const fromTypes = relative(typesRoot, file);
        if (fromTypes === ".." || fromTypes.startsWith(`..${sep}`) || isAbsolute(fromTypes)) {
            throw new Error(`DT test failure path is outside types: ${path}`);
        }
        const metadata = JSON.parse(readFileSync(file, "utf8"));
        if (!isRecord(metadata)) {
            throw new Error(`Invalid package metadata for failing package ${path}`);
        }
        return { file: relative(repoRoot, file), metadata };
    }).filter(({ metadata }) =>
        groups.some(group => isRecord(metadata[group]) && Object.hasOwn(metadata[group], typesName))
    );
    if (!manifests.length) {
        console.error(`No failing packages have a dependency on ${typesName} that can be pinned`);
        return [];
    }
    const typings = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(typesName)}`, fetcher);
    if (!typings) {
        throw new Error(`Cannot determine published versions to pin ${typesName}`);
    }
    const versions = publishedVersions(typings, typesName).filter(version => lt(version, removal.asOfVersion));
    const tags = typings["dist-tags"];
    const pins = [];
    for (const { file, metadata } of manifests) {
        let changed = false;
        for (const group of groups) {
            const dependencies = metadata[group];
            if (!isRecord(dependencies) || !Object.hasOwn(dependencies, typesName)) {
                continue;
            }
            const range = dependencies[typesName];
            if (typeof range !== "string" || !range.trim()) {
                throw new Error(`Invalid ${typesName} dependency in ${file}`);
            }
            const spec = range.trim();
            const tag = isRecord(tags) ? tags[spec] : undefined;
            const version = validRange(spec) !== null
                ? maxSatisfying(versions, spec)
                : typeof tag === "string" && versions.includes(tag)
                ? tag
                : null;
            if (!version) {
                console.error(`No published ${typesName} version satisfies ${JSON.stringify(range)} in ${file}`);
                continue;
            }
            if (version !== range) {
                dependencies[typesName] = version;
                changed = true;
                console.error(`Pinning ${typesName} to ${version} in ${file} (${group})`);
            }
        }
        if (changed) {
            pins.push({ file, content: JSON.stringify(metadata, undefined, 4) + "\n" });
        }
    }
    return pins;
}

/**
 * @param {TestedRemoval[]} removals
 */
export function pullRequestBody(removals) {
    const lines = [
        "Automated removal of declarations now bundled by their npm packages.",
        "Generated by [.github/workflows/remove-bundled-types.yml](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/.github/workflows/remove-bundled-types.yml).",
        "",
        `This run removes **${removals.length}** declaration packages.`,
        "",
        "Each package's latest stable npm release ships resolvable TypeScript types and is newer than every published version of its corresponding `@types` package. This includes implicit declarations found by inspecting the published package's file names.",
        "Popular and Critical packages (more than 200,000 monthly `@types` downloads) are excluded.",
        "",
    ];
    let length = lines.join("\n").length;
    for (const [index, removal] of removals.entries()) {
        const line =
            `- \`@types/${removal.typingsPackageName}\`: [\`${removal.libraryName}@${removal.asOfVersion}\`](https://www.npmjs.com/package/${removal.libraryName}/v/${removal.asOfVersion}); \`pnpm ${
                notNeededArgs(removal).join(" ")
            }\` - passed; \`${removal.testCommand}\` - passed.`;
        // Leave room under GitHub's 65,536-character PR body limit without limiting removals.
        if (length + line.length > 60_000) {
            lines.push(
                `- ${
                    removals.length - index
                } additional removals are included in individual commits. See the workflow logs for all executed commands.`,
            );
            break;
        }
        lines.push(line);
        length += line.length + 1;
    }
    return [
        ...lines,
        "",
        "Each removal passed DT's affected-package tests before its commit, including any downstream dependency pins.",
        "",
    ].join("\n");
}

/**
 * @param {string} repoRoot
 * @param {typeof fetch} fetcher
 * @param {string | undefined} pnpmPath
 * @param {readonly string[] | undefined} packageNames
 */
export async function main(
    repoRoot = root,
    fetcher = npmFetch,
    pnpmPath = process.env.npm_execpath,
    packageNames = undefined,
) {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    if (status.trim()) {
        throw new Error("Removing bundled types requires a clean working tree");
    }

    // Finish all registry checks before changing the checkout.
    const removals = await findRemovals(repoRoot, fetcher, { packageNames });
    if (!removals.length) {
        console.error("No packages to remove");
        return undefined;
    }
    if (!pnpmPath) {
        throw new Error("Run this script with pnpm run remove-bundled-types");
    }
    /** @type {TestedRemoval[]} */
    const testedRemovals = [];
    for (const removal of removals) {
        console.error(
            `Removing @types/${removal.typingsPackageName}: ${removal.libraryName}@${removal.asOfVersion} bundles types`,
        );
        /** @type {import("node:child_process").ExecFileSyncOptions} */
        const options = { cwd: repoRoot, stdio: ["ignore", 2, 2] };
        const changedFiles = new Set([
            join("types", removal.typingsPackageName),
            "notNeededPackages.json",
            "attw.json",
        ]);
        const reportDirectory = mkdtempSync(join(tmpdir(), "dt-removal-tests-"));
        const reportPath = join(reportDirectory, "failures.json");
        let committed = false;
        try {
            runPnpm(repoRoot, pnpmPath, notNeededArgs(removal));
            runPnpm(repoRoot, pnpmPath, ["install"]);
            let tests = runAffectedTests(repoRoot, pnpmPath, reportPath);
            if (!tests.passed) {
                const pins = await dependencyPins(repoRoot, tests.failures, removal, fetcher);
                for (const pin of pins) {
                    changedFiles.add(pin.file);
                    writeFileSync(join(repoRoot, pin.file), pin.content, "utf8");
                }
                if (pins.length) {
                    runPnpm(repoRoot, pnpmPath, ["install"]);
                }
                tests = runAffectedTests(repoRoot, pnpmPath, reportPath);
            }
            if (!tests.passed) {
                console.error(
                    `Skipping @types/${removal.typingsPackageName}: DT tests still fail after dependency pins`,
                );
                continue;
            }
            execFileSync("git", ["add", "--", ...changedFiles], options);
            execFileSync(
                "git",
                [
                    "commit",
                    "-m",
                    `Remove @types/${removal.typingsPackageName}; ${removal.libraryName} now bundles types`,
                ],
                options,
            );
            committed = true;
            testedRemovals.push({ ...removal, testCommand: tests.command });
        } finally {
            try {
                if (!committed) {
                    execFileSync(
                        "git",
                        ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...changedFiles],
                        options,
                    );
                }
            } finally {
                rmSync(reportDirectory, { recursive: true, force: true, maxRetries: 10 });
            }
        }
    }
    if (!testedRemovals.length) {
        console.error("No removals passed DT validation");
        return undefined;
    }
    return pullRequestBody(testedRemovals);
}

/**
 * @param {string} directory
 * @param {string} commit
 * @param {boolean} allowPartial
 */
function readCandidates(directory, commit, allowPartial = false) {
    const files = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".json"));
    const indices = new Set();
    /** @type {Set<string>} */
    const packages = new Set();
    let shardCount;
    for (const file of files) {
        const scan = JSON.parse(readFileSync(join(directory, file.name), "utf8"));
        if (
            !isRecord(scan) || scan.commit !== commit
            || typeof scan.shardCount !== "number" || !Number.isSafeInteger(scan.shardCount) || scan.shardCount < 1
            || typeof scan.shardIndex !== "number" || !Number.isSafeInteger(scan.shardIndex)
            || scan.shardIndex < 0 || scan.shardIndex >= scan.shardCount
            || !Array.isArray(scan.packages)
            || !scan.packages.every(name => typeof name === "string" && /^[a-z0-9][a-z0-9._-]*$/.test(name))
        ) {
            throw new Error(`Invalid scan result or mismatched checkout: ${file.name}`);
        }
        shardCount ??= scan.shardCount;
        if (scan.shardCount !== shardCount || indices.has(scan.shardIndex)) {
            throw new Error(`Inconsistent or duplicate scan shard: ${file.name}`);
        }
        indices.add(scan.shardIndex);
        for (const name of scan.packages) {
            if (packages.has(name)) {
                throw new Error(`Duplicate package in scan results: ${name}`);
            }
            packages.add(name);
        }
    }
    if (shardCount === undefined || (!allowPartial && indices.size !== shardCount)) {
        throw new Error("Missing scan shard results");
    }
    return [...packages].sort();
}

/**
 * @param {string[]} args
 * @param {string} repoRoot
 * @param {typeof fetch} fetcher
 * @param {string | undefined} pnpmPath
 */
export async function runCli(
    args = process.argv.slice(2),
    repoRoot = root,
    fetcher = npmFetch,
    pnpmPath = process.env.npm_execpath,
) {
    const { values } = parseArgs({
        args,
        options: {
            scan: { type: "boolean" },
            "shard-index": { type: "string" },
            "shard-count": { type: "string" },
            candidates: { type: "string" },
            "allow-partial": { type: "boolean" },
            cache: { type: "string" },
        },
    });
    if (values.candidates !== undefined && !values.candidates.trim()) {
        throw new Error("--candidates requires a non-empty directory path");
    }
    if (values.scan && values.candidates !== undefined) {
        throw new Error("--scan and --candidates cannot be combined");
    }
    if (values["allow-partial"] && values.candidates === undefined) {
        throw new Error("--allow-partial requires --candidates");
    }
    if (
        !values.scan
        && (values.cache !== undefined || values["shard-index"] !== undefined || values["shard-count"] !== undefined)
    ) {
        throw new Error("Cache and shard options require --scan");
    }
    if (values.scan || values.candidates !== undefined) {
        const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
        if (values.scan) {
            const shardIndex = Number(values["shard-index"] ?? 0);
            const shardCount = Number(values["shard-count"] ?? 1);
            const readTypesMetadata = values.cache === undefined ? undefined : createCachedTypesMetadata(values.cache);
            const removals = await findRemovals(repoRoot, fetcher, { shardIndex, shardCount, readTypesMetadata });
            return JSON.stringify({
                commit,
                shardIndex,
                shardCount,
                packages: removals.map(removal => removal.typingsPackageName),
            });
        }
        if (values.candidates !== undefined) {
            return main(
                repoRoot,
                fetcher,
                pnpmPath,
                readCandidates(values.candidates, commit, values["allow-partial"]),
            );
        }
    }
    return main(repoRoot, fetcher, pnpmPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().then(body => {
        if (body) {
            console.log(body);
        }
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
