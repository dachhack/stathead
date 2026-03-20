const STORAGE_KEY = 'stathead_api_keys';

export interface ApiKeys {
  sportsDataIO?: string;
}

export function loadApiKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ApiKeys;
  } catch {
    return {};
  }
}

export function saveApiKeys(keys: ApiKeys): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function getSportsDataIOKey(): string | undefined {
  return loadApiKeys().sportsDataIO;
}
