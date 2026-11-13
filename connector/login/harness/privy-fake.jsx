// Stands in for "@privy-io/react-auth" in the render harness build only (render.mjs). Every hook answers from
// window.__YEET_HARNESS__, which each harness page sets, so the real page code renders each screen offline.
import { useState } from "react";

const H = () => globalThis.__YEET_HARNESS__ || {};

export function PrivyProvider({ children }) {
  return children;
}
export function usePrivy() {
  const h = H();
  return {
    ready: h.ready !== false,
    authenticated: !!h.authenticated,
    user: h.user || null,
    getAccessToken: async () => "harness-token",
    logout: async () => {},
  };
}
export function usePrivyClient_experimental() {
  return { app: { getConfig: () => H().appConfig } };
}
export function useLoginWithEmail() {
  const [state, setState] = useState({ status: "initial" });
  return {
    state,
    sendCode: async () => setState({ status: "awaiting-code-input" }),
    loginWithCode: async () => {},
  };
}
export function useLoginWithOAuth() {
  return { initOAuth: async () => {}, loading: false };
}
export function useLoginWithTelegram() {
  return { login: async () => {}, state: { status: "initial" } };
}
export function useSigners() {
  return { addSigners: async () => {} };
}
export function useUser() {
  return { refreshUser: async () => H().user };
}
export function useFundWallet() {
  return { fundWallet: async () => ({ status: "cancelled" }) };
}
