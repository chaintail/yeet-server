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
// The email step of the connect screen (email-step.jsx). Addresses that start with "taken" are another account's;
// the code 123456 links, 429429 is the rate limit, anything else is a wrong code.
let linkAddress = "";
export function useLinkEmail() {
  const no = (code, status) => Promise.reject(Object.assign(Error(code), { privyErrorCode: code, status }));
  return {
    state: { status: "initial" },
    sendCode: async ({ email }) => {
      if (/^taken/.test(email)) return no("linked_to_another_user", 400);
      linkAddress = email;
    },
    linkWithCode: async ({ code }) => {
      if (code === "429429") return no("too_many_requests", 429);
      if (code !== "123456") return no("invalid_credentials", 401);
      const user = H().user || {};
      return { user: { ...user, linkedAccounts: [...(user.linkedAccounts || []), { type: "email", address: linkAddress }] } };
    },
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
export function useDepositFunds() {
  return { depositFunds: async () => Promise.reject(Error("User exited flow")) };
}
export function useFundWallet() {
  return { fundWallet: async () => ({ status: "cancelled" }) };
}
