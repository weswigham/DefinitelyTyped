import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { json } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gt, lt, maxSatisfying, prerelease, valid, validRange } from "semver";
import { list } from "tar";
import ts from "typescript";

// Popular and Critical packages both exceed this limit:
// https://github.com/microsoft/DefinitelyTyped-tools/blob/a014cafa97b565021d8013e4721e8245ef3ded5e/packages/mergebot/src/pr-info.ts#L750
const maxMonthlyDownloads = 200_000;
const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * @param {typeof fetch} fetcher
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} wait
 * @returns {typeof fetch}
 */
export function createNpmFetch(fetcher = fetch, wait = (ms, signal) => setTimeout(ms, undefined, { signal })) {
    return async (input, options) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = (options?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
        const retryableStatuses = [408, 429, 500, 502, 503, 504];
        for (let attempt = 0;; attempt++) {
            signal?.throwIfAborted();
            const timeout = AbortSignal.timeout(30_000);
            const response = await fetcher(input, {
                ...options,
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            if (
                attempt === 5 || !["GET", "HEAD"].includes(method)
                || !retryableStatuses.includes(response.status)
            ) {
                return response;
            }
            await response.body?.cancel();
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
            console.error(`Retrying ${url} in ${delay}ms (retry ${attempt + 1}/5, HTTP ${response.status})`);
            await wait(delay, signal ?? undefined);
        }
    };
}

export const npmFetch = createNpmFetch();

/**
 * @typedef {{ typingsPackageName: string; libraryName: string; asOfVersion: string }} Removal
 * @typedef {Removal & { testCommand: string }} TestedRemoval
 * @typedef {{ path: string; error: string }} TestFailure
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
 */
async function fetchJson(url, fetcher) {
    const response = await fetcher(url, {
        headers: { accept: "application/json" },
    });
    if (response.status === 404) {
        console.error(`Skipping unavailable npm metadata: ${url}`);
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
 * @param {Record<string, unknown>} manifest
 * @param {typeof fetch} fetcher
 */
async function getPackageFiles(manifest, fetcher) {
    if (!isRecord(manifest.dist) || typeof manifest.dist.tarball !== "string") {
        throw new Error(`Missing npm tarball URL for ${manifest.name}@${manifest.version}`);
    }
    const url = manifest.dist.tarball;
    const response = await fetcher(url);
    if (!response.ok) {
        throw new Error(`Tarball request failed (${response.status} ${response.statusText}): ${url}`);
    }
    if (!response.body) {
        throw new Error(`Missing tarball response body: ${url}`);
    }

    /** @type {string[]} */
    const files = [];
    await pipeline(
        Readable.from(response.body),
        list({
            strict: true,
            onReadEntry(entry) {
                if (entry.type === "File" || entry.type === "OldFile") {
                    files.push(entry.path.replace(/^\.\//, "").replace(/^[^/]+\//, ""));
                }
            },
        }),
        { signal: AbortSignal.timeout(30_000) },
    );
    return files;
}

/**
 * @param {string} typingsPackageName
 * @param {typeof fetch} fetcher
 * @returns {Promise<Removal | undefined>}
 */
async function findRemoval(typingsPackageName, fetcher) {
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
        console.error(`Skipping ${libraryName}: latest is a prerelease (${asOfVersion})`);
        return undefined;
    }

    const typesName = `@types/${typingsPackageName}`;
    if (
        [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies].some(dependencies =>
            isRecord(dependencies) && Object.hasOwn(dependencies, typesName)
        )
    ) {
        console.error(`Skipping ${libraryName}: its bundled types still depend on ${typesName}`);
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
        console.error(`Skipping Popular or Critical package ${typesName} (${downloads.downloads} monthly downloads)`);
        return undefined;
    }

    const typings = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(typesName)}`, fetcher);
    if (!typings) {
        return undefined;
    }
    const versions = publishedVersions(typings, typesName);
    if (versions.some(version => !gt(asOfVersion, version))) {
        console.error(`Skipping ${libraryName}@${asOfVersion}: not newer than every published ${typesName} version`);
        return undefined;
    }
    const files = await getPackageFiles(manifest, fetcher);
    if (!hasBundledTypes(libraryName, manifest, files)) {
        return undefined;
    }

    return { typingsPackageName, libraryName, asOfVersion };
}

/**
 * @param {string} repoRoot
 * @param {typeof fetch} fetcher
 */
export async function findRemovals(repoRoot, fetcher = npmFetch) {
    const packageNames = readdirSync(join(repoRoot, "types"), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(repoRoot, "types", entry.name, "package.json")))
        .map(entry => entry.name)
        .sort()
        .filter(name => {
            const metadata = JSON.parse(readFileSync(join(repoRoot, "types", name, "package.json"), "utf8"));
            return !metadata.nonNpm;
        });

    console.error(`Checking ${packageNames.length} npm-backed packages for bundled types...`);
    /** @type {Removal[]} */
    const removals = [];
    for (let start = 0; start < packageNames.length; start += 10) {
        const batch = await Promise.all(packageNames.slice(start, start + 10).map(name => findRemoval(name, fetcher)));
        for (const removal of batch) {
            if (removal) {
                removals.push(removal);
            }
        }
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
 */
export async function main(repoRoot = root, fetcher = npmFetch, pnpmPath = process.env.npm_execpath) {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    if (status.trim()) {
        throw new Error("Removing bundled types requires a clean working tree");
    }

    // Finish all registry checks before changing the checkout.
    const removals = await findRemovals(repoRoot, fetcher);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().then(body => {
        if (body) {
            console.log(body);
        }
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
