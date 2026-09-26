import {
  APIConnectionError, APIError, APITimeoutError, APIUserAbortError,
  TypeSafeClient, noul,
  type Questions, type SystemOneRequest,
} from "@typesafe-ai/sdk";
import { publicConfig, readConfig } from "./config.js";

// Connectivity fixture only. This is not a worker signal or review policy.
export const SMOKE_REQUEST = {
  state: "The TypeSafe Jev connection is ready.",
  questions: { ready: noul("Does the text explicitly say the connection is ready?") },
};

function client() {
  const config = readConfig();
  if (!config.apiKey) {
    throw new Error("TypeSafe API key is missing. Run npm run jev:auth, or set TYPESAFE_API_KEY.");
  }
  return new TypeSafeClient({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultModel: config.model,
    timeout: 10_000,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
}

export function status() { return publicConfig(readConfig()); }

async function request<T>(operation: () => PromiseLike<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Do not surface API error bodies, credentials, or SDK debug logs.
    if (error instanceof APIError) throw new Error(`TypeSafe request failed (HTTP ${error.status}).`);
    if (error instanceof APITimeoutError) throw new Error("TypeSafe request timed out after 10 seconds.");
    if (error instanceof APIUserAbortError) throw new Error("TypeSafe request was cancelled.");
    if (error instanceof APIConnectionError) throw new Error("Could not connect to the TypeSafe API.");
    throw error;
  }
}

export async function evaluate<Q extends Questions>(input: SystemOneRequest<Q>, signal?: AbortSignal) {
  const api = client();
  return request(() => api.systemOne(input, { signal }));
}

export async function listModels(signal?: AbortSignal) {
  const api = client();
  return request(() => api.models.list({ signal }));
}

export function smoke(signal?: AbortSignal) { return evaluate(SMOKE_REQUEST, signal); }
