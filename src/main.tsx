import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider } from "@mysten/dapp-kit";
import { getFullnodeUrl } from "@mysten/sui/client";
import "@mysten/dapp-kit/dist/index.css";
import MockPage from "@/pages/Mock";
import PaymentPage from "@/pages/Payment";
import AuthCallback from "@/pages/AuthCallback";
import PointsPage from "@/pages/Points";
import AdminPage from "@/pages/Admin";
import BookPage from "@/pages/Book";
import "./index.css";

const queryClient = new QueryClient();
const network = (import.meta.env.VITE_SUI_NETWORK as "devnet" | "testnet" | "mainnet") || "testnet";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={{
          devnet: { url: getFullnodeUrl("devnet") },
          testnet: { url: getFullnodeUrl("testnet") },
          mainnet: { url: getFullnodeUrl("mainnet") },
        }}
        defaultNetwork={network}
      >
        <WalletProvider autoConnect>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Navigate to="/mock" replace />} />
              <Route path="/mock" element={<MockPage />} />
              <Route path="/payment" element={<PaymentPage />} />
              <Route path="/auth/callback" element={<AuthCallback />} />
              <Route path="/points" element={<PointsPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/book" element={<BookPage />} />
            </Routes>
          </BrowserRouter>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
