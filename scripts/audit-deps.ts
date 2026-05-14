#!/usr/bin/env ts-node
/**
 * Supply-chain pre-flight check for package-lock.json.
 *
 * Walks every resolved package entry and:
 *   - Flags any package whose tarball was published in a known attack window.
 *   - Flags any package whose name matches a known-compromised list.
 *   - Verifies every entry has an `integrity` SHA-512 hash.
 *
 * Exits non-zero if anything looks suspicious. Run before `npm ci` succeeds.
 */
import fs from "fs";
import path from "path";
import https from "https";

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
}

interface Lockfile {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
}

interface AttackWindow {
  name: string;
  start: string; // ISO
  end: string; // ISO
}

const ATTACK_WINDOWS: AttackWindow[] = [
  {
    name: "Mini Shai-Hulud / TanStack (May 2026)",
    start: "2026-05-11T18:00:00Z",
    end: "2026-05-15T00:00:00Z",
  },
];

const KNOWN_COMPROMISED_NAME_PATTERNS: RegExp[] = [
  /^@tanstack\//,
  /^@mistralai\//,
  /^@uipath\//,
  /^@bitwarden\/cli$/,
  /^@bitwarden\/sdk-/,
];

const KNOWN_COMPROMISED_AUTHORS: string[] = [
  // Add specific compromised maintainer usernames here as they're disclosed.
];

const lockPath = path.join(process.cwd(), "package-lock.json");
if (!fs.existsSync(lockPath)) {
  console.error("No package-lock.json found in cwd. Run `npm install` first.");
  process.exit(1);
}

const lock: Lockfile = JSON.parse(fs.readFileSync(lockPath, "utf8"));

interface Issue {
  pkg: string;
  version: string;
  reason: string;
}

const issues: Issue[] = [];

interface Pending {
  name: string;
  version: string;
}
const pending: Pending[] = [];

const seen = new Set<string>();
for (const [keyPath, entry] of Object.entries(lock.packages)) {
  if (!entry.version) continue;
  // node_modules/<scope>/<name> or node_modules/<name>
  const m = keyPath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  if (!m) continue;
  const name = m[1];
  const dedupKey = `${name}@${entry.version}`;
  if (seen.has(dedupKey)) continue;
  seen.add(dedupKey);

  if (!entry.integrity) {
    issues.push({
      pkg: name,
      version: entry.version,
      reason: "Missing integrity hash in package-lock.json",
    });
    continue;
  }
  if (!entry.integrity.startsWith("sha512-")) {
    issues.push({
      pkg: name,
      version: entry.version,
      reason: `Weak integrity algorithm: ${entry.integrity.split("-")[0]}`,
    });
  }

  if (KNOWN_COMPROMISED_NAME_PATTERNS.some((re) => re.test(name))) {
    issues.push({
      pkg: name,
      version: entry.version,
      reason: "Name matches a known-compromised package list",
    });
    continue;
  }

  pending.push({ name, version: entry.version });
}

interface RegistryReport {
  publishedAt?: string;
  publisher?: string;
}

function checkRegistry(name: string, version: string): Promise<RegistryReport> {
  // npm registry tolerates @ in path; just encode any slash for scoped names manually.
  const path =
    "/" + (name.startsWith("@") ? name.replace("/", "%2F") : name);
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: "registry.npmjs.org",
        path,
        headers: {
          accept: "application/vnd.npm.install-v1+json",
          "user-agent": "tonkey-audit/0.0.1",
        },
        timeout: 15_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(
              new Error(`HTTP ${res.statusCode ?? "?"} for ${name}`),
            );
          }
          try {
            const data = JSON.parse(body);
            const time = data.time?.[version];
            const npmUser = data.versions?.[version]?._npmUser?.name;
            resolve({ publishedAt: time, publisher: npmUser });
          } catch (e: any) {
            reject(new Error(`JSON parse error for ${name}: ${e.message}`));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Registry timeout for ${name}`));
    });
    req.on("error", (e) =>
      reject(new Error(`Registry request error for ${name}: ${e.message}`)),
    );
  });
}

async function runLimited<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (cursor < items.length) {
        const my = cursor++;
        try {
          await worker(items[my]);
        } catch {
          // swallow — issues already collected by worker
        }
      }
    });
  await Promise.all(runners);
}

(async () => {
  console.log(
    `Auditing ${seen.size} unique packages from package-lock.json...`,
  );

  let done = 0;
  await runLimited(
    pending,
    async ({ name, version }) => {
      try {
        const report = await checkRegistry(name, version);
        if (report.publishedAt) {
          for (const win of ATTACK_WINDOWS) {
            if (
              report.publishedAt >= win.start &&
              report.publishedAt <= win.end
            ) {
              issues.push({
                pkg: name,
                version,
                reason: `Published ${report.publishedAt} — inside attack window "${win.name}"`,
              });
            }
          }
        }
        if (
          report.publisher &&
          KNOWN_COMPROMISED_AUTHORS.includes(report.publisher)
        ) {
          issues.push({
            pkg: name,
            version,
            reason: `Published by known-compromised author ${report.publisher}`,
          });
        }
      } catch (err: any) {
        issues.push({
          pkg: name,
          version,
          reason: `Registry lookup failed: ${err?.message || err}`,
        });
      } finally {
        done++;
        if (done % 25 === 0 || done === pending.length) {
          process.stdout.write(`  …${done}/${pending.length}\n`);
        }
      }
    },
    8,
  );

  if (issues.length === 0) {
    console.log("✓ No suspicious entries found.");
    process.exit(0);
  }
  console.error(`\n⚠  ${issues.length} suspicious entries:`);
  for (const i of issues) {
    console.error(`  • ${i.pkg}@${i.version} — ${i.reason}`);
  }
  process.exit(1);
})();
