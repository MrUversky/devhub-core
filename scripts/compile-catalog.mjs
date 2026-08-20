import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";
import { validateHostsDocument, validateProjectDocument } from "./catalog-validation.mjs";
import { resolveDevHubPaths, resolveInstancePresentation } from "./devhub-config.mjs";
import { catalogForPresentation } from "../lib/catalog-presentation.mjs";
import { createConnectionSnapshot } from "../lib/connection-snapshot.mjs";

const paths = resolveDevHubPaths(process.cwd(), process.env);

function fail(message) {
  throw new Error(`catalog: ${message}`);
}

let hostsDocument;
try {
  hostsDocument = parse(await readFile(paths.hostsPath, "utf8"));
} catch (error) {
  if (error?.code === "ENOENT") fail(`${paths.hostsPath} is missing; set DEVHUB_CATALOG_DIR to a directory containing hosts.yaml and projects/`);
  throw error;
}
const { hostIds } = validateHostsDocument(hostsDocument, paths.hostsPath);

let projectFiles;
try {
  projectFiles = (await readdir(paths.projectDirectory)).filter((file) => file.endsWith(".yaml")).sort();
} catch (error) {
  if (error?.code === "ENOENT") fail(`${paths.projectDirectory} is missing; catalog needs a projects directory`);
  throw error;
}
const projects = [];
const projectIds = new Set();

for (const file of projectFiles) {
  const source = path.join(paths.projectDirectory, file);
  const project = parse(await readFile(source, "utf8"));
  validateProjectDocument(project, { source, hostIds, expectedId: file.replace(/\.yaml$/, "") });
  if (projectIds.has(project.id)) fail(`duplicate project ${project.id}`);
  projectIds.add(project.id);
  projects.push(project);
}

projects.sort((left, right) => left.title.localeCompare(right.title));
let connectionProfileDocument;
try {
  connectionProfileDocument = JSON.parse(await readFile(paths.connectionProfilesPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const connections = createConnectionSnapshot(connectionProfileDocument);
let publicSnapshot = false;
try {
  await access(path.join(paths.root, ".devhub-public-snapshot"));
  publicSnapshot = true;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const instance = resolveInstancePresentation(process.env, { publicSnapshot });
const catalog = { version: 1, instance, hosts: hostsDocument.hosts, projects, connections };
const serialized = `${JSON.stringify(catalogForPresentation(catalog), null, 2)}\n`;
const outputFiles = paths.generatedOutputs;

if (process.env.DEVHUB_CATALOG_CHECK === "1") {
  for (const outputFile of outputFiles) {
    let existing;
    try {
      existing = await readFile(outputFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") fail(`${path.relative(paths.root, outputFile)} is missing; run npm run devhub -- validate`);
      throw error;
    }
    if (existing !== serialized) fail(`${path.relative(paths.root, outputFile)} is stale; run npm run devhub -- validate`);
  }
} else {
  await Promise.all(outputFiles.map(async (outputFile) => {
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(outputFile, serialized);
  }));
}

console.log(`catalog: ${projects.length} projects, ${projects.reduce((sum, project) => sum + project.services.length, 0)} services${process.env.DEVHUB_CATALOG_CHECK === "1" ? " (current)" : ""}`);
