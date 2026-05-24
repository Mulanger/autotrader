import { FETCH_RETRY_COUNT, FETCH_TIMEOUT_MS } from './config.js';

export class FetchHttpError extends Error {
  constructor(response, url, body = '') {
    super(`${response.status} ${response.statusText} for ${url}`);
    this.name = 'FetchHttpError';
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = String(url);
    this.body = body;
  }
}

export async function fetchJson(url, options = {}) {
  const retries = numberOrFallback(options.retries, FETCH_RETRY_COUNT);
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      return await fetchJsonOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableFetchError(error)) throw error;
      await sleep(retryDelayMs(attempt));
      attempt += 1;
    }
  }

  throw lastError;
}

export function isHttpStatus(error, status) {
  return Number(error?.status) === status;
}

async function fetchJsonOnce(url, options) {
  const timeoutMs = numberOrFallback(options.timeoutMs, FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new FetchHttpError(response, url, body.slice(0, 500));
    }
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Fetch timed out after ${timeoutMs}ms for ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableFetchError(error) {
  if (error instanceof FetchHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return /fetch failed|timed out|network/i.test(String(error?.message || error));
}

function retryDelayMs(attempt) {
  return Math.min(2_000, 250 * 2 ** attempt);
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
