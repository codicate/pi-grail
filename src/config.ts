import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Resolve against the linked package, not Pi's current working directory.
const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");

export interface JevConfig {
  apiKey?: string;
  keySource: "environment" | "dotenv" | "file" | "missing";
  keyFile: string;
  envFile: string;
  baseURL: string;
  model: string;
}

export function readConfig(providedEnv?: NodeJS.ProcessEnv, envFile = DEFAULT_ENV_FILE): JevConfig {
  let dotenv: NodeJS.ProcessEnv = {};
  if (providedEnv === undefined) {
    try { dotenv = parseEnv(readFileSync(envFile, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Cannot read or parse the extension's .env file. Check its format and permissions.");
      }
    }
  }
  const runtimeEnv = providedEnv ?? process.env;
  const env = { ...dotenv, ...runtimeEnv };
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const keyFile = resolve(env.PI_GRAIL_API_KEY_FILE?.trim() || join(agentDir, "secrets", "typesafe_api_key"));
  let apiKey = env.TYPESAFE_API_KEY?.trim() || undefined;
  let keySource: JevConfig["keySource"] = apiKey
    ? (runtimeEnv.TYPESAFE_API_KEY === undefined && dotenv.TYPESAFE_API_KEY ? "dotenv" : "environment")
    : "missing";
  if (!apiKey) {
    try {
      apiKey = readFileSync(keyFile, "utf8").trim() || undefined;
      if (apiKey) keySource = "file";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Cannot read the TypeSafe key file. Check its path and permissions.");
      }
    }
  }
  const baseURL = (env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(baseURL); }
  catch { throw new Error("TYPESAFE_BASE_URL must be a valid HTTP(S) API root."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("TYPESAFE_BASE_URL must be an HTTP(S) API root without credentials, query, or fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("TYPESAFE_BASE_URL is the API root; omit /v1 and other path suffixes.");
  }
  return {
    apiKey, keySource, keyFile, envFile, baseURL,
    model: env.PI_GRAIL_JEV_MODEL?.trim() || env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest",
  };
}

export function publicConfig(config: JevConfig) {
  return {
    configured: Boolean(config.apiKey),
    keySource: config.keySource,
    keyFile: config.keyFile,
    envFile: config.envFile,
    baseURL: config.baseURL,
    model: config.model,
  };
}
