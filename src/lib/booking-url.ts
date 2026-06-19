import type { BookingData } from "./types";

const SESSION_KEY = "booking:data";

export function encodeBookingData(data: BookingData): string {
  return btoa(encodeURIComponent(JSON.stringify(data)));
}

export function decodeBookingData(encoded: string): BookingData | null {
  try {
    return JSON.parse(decodeURIComponent(atob(encoded)));
  } catch {
    return null;
  }
}

/** Persist booking data so it survives the Google OAuth redirect cycle. */
export function saveBookingToSession(data: BookingData): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

export function loadBookingFromSession(): BookingData | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Generate a short random booking ID. */
export function generateBookingId(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `BK-${rand}`;
}
