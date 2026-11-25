/**
 * Centralized localStorage abstraction module
 *
 * Provides type-safe wrappers for all localStorage operations.
 * All localStorage access should go through this module to ensure
 * consistent error handling and environment checks.
 */

/**
 * Check if localStorage is available in the current environment
 */
function isStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get an item from localStorage
 * @param key - The storage key
 * @returns The stored value or null if not found/unavailable
 */
export function getItem(key: string): string | null {
  if (!isStorageAvailable()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Set an item in localStorage
 * @param key - The storage key
 * @param value - The value to store
 * @returns true if successful, false otherwise
 */
export function setItem(key: string, value: string): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove an item from localStorage
 * @param key - The storage key to remove
 * @returns true if successful, false otherwise
 */
export function removeItem(key: string): boolean {
  if (!isStorageAvailable()) return false;
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a JSON-parsed item from localStorage
 * @param key - The storage key
 * @returns The parsed value or null if not found/invalid
 */
export function getJSON<T>(key: string): T | null {
  const value = getItem(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Set a JSON-stringified item in localStorage
 * @param key - The storage key
 * @param value - The value to stringify and store
 * @returns true if successful, false otherwise
 */
export function setJSON<T>(key: string, value: T): boolean {
  try {
    return setItem(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

/**
 * Storage module for named exports
 */
export const storage = {
  getItem,
  setItem,
  removeItem,
  getJSON,
  setJSON,
  isAvailable: isStorageAvailable,
};
