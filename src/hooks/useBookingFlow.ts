import { useState, useCallback, useEffect, useRef } from "react";
import {
  useWallets,
  useConnectWallet,
  useCurrentAccount,
  useDisconnectWallet,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { fromB64, toB64 } from "@mysten/sui/utils";
import type { BookingData, PaymentStatus, Currency } from "@/lib/types";
import { getSuiBalance, getStablecoinBalance, getSuiClient } from "@/lib/sui-client";
import { executeBookingPayment, sendPaymentCallback } from "@/lib/payment";
import {
  buildGoogleAuthUrl,
  clearSession,
  isReady,
  loadSession,
  signTxWithZkLogin,
  setAuthPref,
  getAuthPref,
  clearAuthPref,
} from "@/lib/zklogin";
import { CONFIG } from "@/lib/config";

export type Step = "loading" | "connect" | "connecting" | "ready" | "paying" | "done";
export type AuthMethod = "slush" | "zklogin" | null;

export interface WalletInfo {
  address: string | null;
  balance: string | null;        // SUI
  balanceStable: string | null;  // selected stablecoin
  points: number | null;         // loyalty points balance
}

export function useBookingFlow(booking: BookingData, callbackUrl: string) {
  const currency: Currency = booking.fee.currency ?? "USDC";
  const [step, setStep] = useState<Step>("loading");
  const [wallet, setWallet] = useState<WalletInfo>({ address: null, balance: null, balanceStable: null, points: null });
  // Local booking copy — updated when points are redeemed
  const [activeFee, setActiveFee] = useState(booking.fee);
  const [authMethod, setAuthMethod] = useState<AuthMethod>(null);
  const [result, setResult] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const suiWallets = useWallets();
  const connectWallet = useConnectWallet();
  const disconnectWallet = useDisconnectWallet();
  const currentAccount = useCurrentAccount();
  const signAndExecTx = useSignAndExecuteTransaction();
  const signAndExecTxRef = useRef(signAndExecTx);
  signAndExecTxRef.current = signAndExecTx;

  const DONE_KEY = `booking_done_${booking.booking_id}`;

  const onConnected = useCallback(async (address: string, method: AuthMethod) => {
    const [balance, balanceStable, pointsRes] = await Promise.all([
      getSuiBalance(address).catch(() => "0.0000"),
      getStablecoinBalance(address, currency).catch(() => "0.00"),
      fetch(`/api/points/${address}`).then((r) => r.json() as Promise<{ balance: number }>).catch(() => ({ balance: 0 })),
    ]);
    setWallet({ address, balance, balanceStable, points: pointsRes.balance });
    setAuthMethod(method);
    setStep("ready");
  }, [currency]);

  const refreshBalance = useCallback(async () => {
    const addr = wallet.address;
    if (!addr) return;
    const [balance, balanceStable, pointsRes] = await Promise.all([
      getSuiBalance(addr).catch(() => "0.0000"),
      getStablecoinBalance(addr, currency).catch(() => "0.00"),
      fetch(`/api/points/${addr}`).then((r) => r.json() as Promise<{ balance: number }>).catch(() => ({ balance: 0 })),
    ]);
    setWallet((prev) => ({ ...prev, balance, balanceStable, points: pointsRes.balance }));
  }, [wallet.address, currency]);

  // ── Points redemption ────────────────────────────────────────────
  const redeemPoints = useCallback(async (points: number) => {
    if (!wallet.address) throw new Error("wallet not connected");
    const res = await fetch("/api/points/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet.address, points, booking_id: booking.booking_id }),
    });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      throw new Error(body.error ?? "Redemption failed");
    }
    const { token, discount_value } = await res.json() as { token: string; discount_value: number };
    const newAmount = Math.max(0, (booking.fee.amount_after_coupon ?? booking.fee.amount_usdc) - discount_value);
    setActiveFee((f) => ({ ...f, amount_after_coupon: parseFloat(newAmount.toFixed(2)), points_redeemed: points, redemption_token: token }));
    setWallet((prev) => ({ ...prev, points: (prev.points ?? 0) - points }));
    return { token, discount_value };
  }, [wallet.address, booking]);

  const releasePoints = useCallback(async (token: string) => {
    await fetch("/api/points/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => {});
    setActiveFee(booking.fee);
    await refreshBalance();
  }, [booking.fee, refreshBalance]);

  // On mount: restore the auth method the user explicitly chose last time.
  // Without this, dapp-kit's Slush auto-reconnect always wins over a valid
  // zkLogin session, which causes the wrong address (and wrong points) to load.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoFired.current) return;

    // Restore done state for this booking (survives remounts / StrictMode)
    const cached = sessionStorage.getItem(DONE_KEY);
    if (cached) {
      try {
        setResult(JSON.parse(cached) as PaymentStatus);
        setStep("done");
        autoFired.current = true;
        return;
      } catch { /* ignore parse error, fall through */ }
    }

    const pref = getAuthPref();
    const slushAddress = currentAccount?.address;
    const session = loadSession();
    const zkAddress = isReady(session) ? session.address : null;

    // Honour the user's last explicit choice when both are available
    if (pref === "zklogin" && zkAddress) {
      autoFired.current = true;
      onConnected(zkAddress, "zklogin");
      return;
    }
    if (pref === "slush" && slushAddress) {
      autoFired.current = true;
      onConnected(slushAddress, "slush");
      return;
    }

    // No preference stored — fall back to whichever is available
    if (slushAddress) {
      autoFired.current = true;
      onConnected(slushAddress, "slush");
      return;
    }
    autoFired.current = true;
    if (zkAddress) {
      onConnected(zkAddress, "zklogin");
    } else {
      setStep("connect");
    }
  }, [currentAccount?.address, onConnected, DONE_KEY]);

  // Connect via Slush wallet
  const connectSlush = useCallback(async () => {
    if (suiWallets.length === 0) {
      setError("No Sui wallet found. Please install Slush.");
      return;
    }
    setError(null);
    setStep("connecting");
    const target = suiWallets.find((w) => w.name === "Slush") ?? suiWallets[0];
    try {
      const res = await connectWallet.mutateAsync({ wallet: target });
      const address = res.accounts[0]?.address;
      if (!address) throw new Error("No account returned from wallet");
      setAuthPref("slush");
      await onConnected(address, "slush");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed");
      setStep("connect");
    }
  }, [suiWallets, connectWallet, onConnected]);

  // Connect via Google (zkLogin + Shinami)
  const loginWithGoogle = useCallback(async (currentSearch: string) => {
    if (!CONFIG.GOOGLE_CLIENT_ID) {
      setError("Google login not configured — set VITE_GOOGLE_CLIENT_ID in .env");
      return;
    }
    setError(null);
    setStep("connecting");
    try {
      setAuthPref("zklogin");
      const authUrl = await buildGoogleAuthUrl(currentSearch);
      window.location.href = authUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start Google login");
      setStep("connect");
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!wallet.address) return;
    setError(null);
    setStep("paying");

    // Build booking with current fee (may include redemption discount)
    const bookingWithFee = { ...booking, fee: activeFee };

    try {
      let paymentResult: PaymentStatus;
      const client = getSuiClient();

      if (authMethod === "zklogin") {
        const session = loadSession();
        if (!isReady(session)) {
          setError("Session expired — please sign in with Google again");
          setStep("connect");
          return;
        }

        // session.address is the canonical Sui address from Shinami's wallet service —
        // it's what Shinami's prover proves and what the on-chain verifier derives.
        const zkSenderAddress = session.address;
        console.log("[zklogin confirm] sender:", zkSenderAddress, "wallet.address:", wallet.address);

        paymentResult = await executeBookingPayment({
          booking: bookingWithFee,
          userAddress: zkSenderAddress,
          currency,
          signAndExecute: async (tx) => {
            // Build TransactionKind bytes only (no sender/gas — Shinami adds those)
            const kindBytes = await tx.build({ client, onlyTransactionKind: true });
            const kindB64 = toB64(kindBytes);

            // Get sponsored TransactionData from Shinami via our server
            const sponsorRes = await fetch("/api/sponsor/transaction", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ txBytes: kindB64, sender: zkSenderAddress }),
            });
            if (!sponsorRes.ok) {
              const err = await sponsorRes.json() as { error?: string };
              throw new Error(err.error ?? "Gas sponsorship failed");
            }
            const { txBytes: sponsoredB64, signature: sponsorSig } =
              await sponsorRes.json() as { txBytes: string; signature: string };

            // Sign the full sponsored TransactionData with zkLogin key
            const sponsoredBytes = fromB64(sponsoredB64);
            const zkSig = await signTxWithZkLogin(sponsoredBytes, session);

            // Execute with both signatures: [userZkSig, sponsorSig]
            return client.executeTransactionBlock({
              transactionBlock: sponsoredB64,
              signature: [zkSig, sponsorSig],
              options: { showEffects: true, showObjectChanges: true },
            }) as Promise<{ digest: string }>;
          },
        });
      } else {
        // Slush wallet — standard dapp-kit sign + execute
        paymentResult = await executeBookingPayment({
          booking: bookingWithFee,
          userAddress: wallet.address,
          currency,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signAndExecute: (tx) => signAndExecTxRef.current.mutateAsync({ transaction: tx as any }) as any,
        });
      }

      // Attach user_address + redemption_token so server can award/finalize points
      const enrichedResult = {
        ...paymentResult,
        user_address: wallet.address,
        ...(activeFee.redemption_token ? { redemption_token: activeFee.redemption_token } : {}),
      };

      setResult(paymentResult);
      setStep("done");
      sessionStorage.setItem(DONE_KEY, JSON.stringify(paymentResult));

      if (callbackUrl) {
        const cbResponse = await sendPaymentCallback(callbackUrl, enrichedResult);
        // Update points balance from server response if available
        if (cbResponse.ok && cbResponse.points) {
          setWallet((prev) => ({ ...prev, points: cbResponse.points!.balance }));
        }
      }
    } catch (e) {
      // Release reserved points if tx failed
      if (activeFee.redemption_token) {
        await releasePoints(activeFee.redemption_token);
      }
      setError(e instanceof Error ? e.message : "Transaction failed");
      setStep("ready");
    }
  }, [booking, wallet, authMethod, callbackUrl, activeFee, releasePoints]);

  const disconnect = useCallback(() => {
    if (authMethod === "slush") disconnectWallet.mutate();
    else if (authMethod === "zklogin") clearSession();
    clearAuthPref();
    sessionStorage.removeItem(DONE_KEY);
    setWallet({ address: null, balance: null, balanceStable: null, points: null });
    setActiveFee(booking.fee);
    setAuthMethod(null);
    setResult(null);
    setError(null);
    autoFired.current = false;
    setStep("connect");
  }, [authMethod, disconnectWallet, booking.fee, DONE_KEY]);

  return { step, wallet, currency, activeFee, authMethod, result, error, connectSlush, loginWithGoogle, confirm, disconnect, refreshBalance, redeemPoints, releasePoints };
}
