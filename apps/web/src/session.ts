import { create } from "zustand";
import type { User } from "@motionily/protocol";

const STORAGE_KEY = "motionily.session";

type Session = { token: string | null; user: User | null };
type SessionStore = Session & { login: (s: { token: string; user: User }) => void; logout: () => void };

function load(): Session {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Session;
  } catch {
    // Storage blocked or corrupted: start logged out.
  }
  return { token: null, user: null };
}

function save(s: Session) {
  try {
    if (s.token) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore: session just won't survive a reload.
  }
}

export const useSession = create<SessionStore>((set) => ({
  ...load(),
  login: (s) => {
    save(s);
    set(s);
  },
  logout: () => {
    save({ token: null, user: null });
    set({ token: null, user: null });
  },
}));
