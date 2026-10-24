import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut as fbSignOut,
  deleteUser,
  type User,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { firebaseAuth } from '../lib/firebase';

export interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
  getIdToken(): Promise<string>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

const RETURN_TO_KEY = 'aw:returnTo';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const auth = firebaseAuth();
    return auth.onAuthStateChanged((u) => {
      setUser(u);
      setLoading(false);
      // If we returned from a redirect sign-in with a pending destination,
      // send the user back (e.g. /device?user_code=...).
      if (u) {
        const returnTo = sessionStorage.getItem(RETURN_TO_KEY);
        if (returnTo) {
          sessionStorage.removeItem(RETURN_TO_KEY);
          if (returnTo !== window.location.pathname + window.location.search) {
            window.location.assign(returnTo);
          }
        }
      }
    });
  }, []);

  const signIn = useCallback(async () => {
    setError(null);
    const auth = firebaseAuth();
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      // Fall back to redirect when the popup can't be used.
      const code = e instanceof FirebaseError ? e.code : '';
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        sessionStorage.setItem(
          RETURN_TO_KEY,
          window.location.pathname + window.location.search,
        );
        await signInWithRedirect(auth, provider);
        return;
      }
      setError(e instanceof Error ? e.message : 'Sign-in failed');
      throw e;
    }
  }, []);

  const signOut = useCallback(async () => {
    await fbSignOut(firebaseAuth());
  }, []);

  const deleteAccount = useCallback(async () => {
    const u = firebaseAuth().currentUser;
    if (!u) return;
    await deleteUser(u);
  }, []);

  const getIdToken = useCallback(async () => {
    const u = firebaseAuth().currentUser;
    if (!u) throw new Error('Not signed in');
    return u.getIdToken();
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, signIn, signOut, deleteAccount, getIdToken }),
    [user, loading, error, signIn, signOut, deleteAccount, getIdToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
