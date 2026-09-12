/**
 * Browser client for Swap Meet by StatHead (workers/swap-meet). Creates a
 * meet, reads it, sends actions, builds the shareable links, and remembers
 * the meets this browser opened or joined so they can be found again.
 */

import type { Meet, MeetAction, NewMeetInput, Role } from './swapMeetCore';
import { swapHash } from './hashRoute';

const SWAP_MEET_URL: string = import.meta.env?.VITE_SWAP_MEET_URL ?? 'https://swap-meet.dachhack.workers.dev';

export interface CreatedMeet { id: string; proposerKey: string; partnerKey: string; meet: Meet }
export interface MeetRead { meet: Meet; role: Role; partnerKey?: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SWAP_MEET_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  } catch {
    throw new Error('Could not reach the Swap Meet service. Check your connection and try again.');
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error || `Swap Meet service returned ${res.status}`);
  return body;
}

export function createMeet(input: NewMeetInput): Promise<CreatedMeet> {
  return call<CreatedMeet>('/meets', { method: 'POST', body: JSON.stringify(input) });
}

export function fetchMeet(id: string, key: string | null): Promise<MeetRead> {
  return call<MeetRead>(`/meets/${encodeURIComponent(id)}${key ? `?k=${encodeURIComponent(key)}` : ''}`);
}

export function sendAction(id: string, key: string, action: MeetAction): Promise<{ meet: Meet; role: Role }> {
  return call(`/meets/${encodeURIComponent(id)}/actions?k=${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify(action) });
}

/** Full shareable URL for a meet (the page's own origin + path, hash route). */
export function meetUrl(id: string, key?: string | null): string {
  if (typeof window === 'undefined') return swapHash(id, key);
  return `${window.location.origin}${window.location.pathname}${swapHash(id, key)}`;
}

// ── Meets this browser knows about ────────────────────────────────────────

export interface MeetHandle {
  id: string;
  key: string;
  role: 'proposer' | 'partner';
  title: string;
  at: string;
  /** Kept for the proposer so the partner link can be copied again. */
  partnerKey?: string;
}

const LS_KEY = 'stathead:swap-meets';

export function listMeets(): MeetHandle[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const list = raw ? (JSON.parse(raw) as MeetHandle[]) : [];
    return Array.isArray(list) ? list.filter((h) => h && typeof h.id === 'string' && typeof h.key === 'string') : [];
  } catch { return []; }
}

export function rememberMeet(h: MeetHandle): void {
  try {
    const list = listMeets().filter((x) => x.id !== h.id);
    list.unshift(h);
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 40)));
  } catch { /* storage unavailable */ }
}

export function forgetMeet(id: string): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(listMeets().filter((x) => x.id !== id))); } catch { /* ignore */ }
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
