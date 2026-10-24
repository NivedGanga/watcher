import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createUserApi, type UserApi } from './api';
import { getConfig } from '../config';
import { useAuth } from '../auth/AuthContext';

const ApiContext = createContext<UserApi | null>(null);

export function useApi(): UserApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside ApiProvider');
  return api;
}

export function ApiProvider({ children }: { children: ReactNode }) {
  const { getIdToken } = useAuth();
  const api = useMemo(() => createUserApi(getConfig().apiBaseUrl, getIdToken), [getIdToken]);
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export { ApiContext };
