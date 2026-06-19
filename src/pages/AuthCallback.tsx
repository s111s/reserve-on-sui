import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { finalizeLogin, popReturnParams } from "@/lib/zklogin";

export default function AuthCallback() {
  const navigate = useNavigate();
  const handled = useRef(false);
  const [status, setStatus] = useState("Verifying identity…");

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    async function handle() {
      // Google returns id_token in the URL hash: #id_token=<jwt>&...
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const jwt = hash.get("id_token");

      if (!jwt) {
        setStatus("Login failed — no token received. Redirecting…");
        setTimeout(() => navigate("/mock", { replace: true }), 2000);
        return;
      }

      try {
        setStatus("Getting your wallet address…");
        await finalizeLogin(jwt);
        setStatus("Done! Redirecting…");
        const returnParams = popReturnParams();
        const parsed = returnParams ? new URLSearchParams(returnParams) : null;
        const redirect = parsed?.get("redirect");
        const destination = redirect
          ? redirect
          : returnParams
            ? `/payment${returnParams}`
            : "/mock";
        navigate(destination, { replace: true });
      } catch (err) {
        console.error("zkLogin finalize failed:", err);
        setStatus(`Login error: ${err instanceof Error ? err.message : "unknown"}`);
        setTimeout(() => navigate("/mock", { replace: true }), 3000);
      }
    }

    handle();
  }, [navigate]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--bg)", gap: "1rem" }}>
      <span style={{ display: "inline-block", width: 22, height: 22, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <span style={{ color: "var(--text-dim)", fontSize: "0.88rem" }}>{status}</span>
    </div>
  );
}
