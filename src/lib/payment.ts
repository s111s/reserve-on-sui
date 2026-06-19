import { Transaction } from "@mysten/sui/transactions";
import { getSuiClient, getStablecoinCoins } from "./sui-client";
import { CONFIG } from "./config";
import { buildOnChainFields } from "./privacy";
import type { BookingData, PaymentStatus, PaymentInfo, ReceiptInfo, Currency } from "./types";

type ExecResult = { digest: string; [key: string]: unknown };

function getFeeReceiver(booking: BookingData): string {
  const addr = booking.merchant.wallet_address || CONFIG.FEE_RECEIVER_ADDRESS;
  if (!addr || !/^0x[0-9a-fA-F]{64}$/.test(addr)) {
    throw new Error("Fee receiver address not configured — set merchant wallet_address or VITE_FEE_RECEIVER_ADDRESS in .env");
  }
  return addr;
}

export async function executeBookingPayment(params: {
  booking: BookingData;
  userAddress: string;
  currency?: Currency;
  signAndExecute: (tx: Transaction) => Promise<ExecResult>;
}): Promise<PaymentStatus> {
  const { booking, userAddress } = params;
  const currency: Currency = params.currency ?? booking.fee.currency ?? "USDC";
  const client = getSuiClient();

  try {
    const hasContract = CONFIG.PACKAGE_ID && /^0x[0-9a-fA-F]{64}$/.test(CONFIG.PACKAGE_ID);
    const hasFee = booking.fee.has_fee && booking.fee.amount_usdc > 0;

    if (!hasFee && !hasContract) {
      return buildStatus("free", booking, null, null, "Booking confirmed (off-chain)");
    }

    const tx = new Transaction();
    tx.setSender(userAddress);

    let paymentInfo: PaymentInfo | null = null;

    if (hasFee) {
      const feeReceiver = getFeeReceiver(booking);
      const feeAmount = booking.fee.amount_after_coupon ?? booking.fee.amount_usdc;
      const amountMicro = BigInt(Math.round(feeAmount * 1e6));
      const coins = await getStablecoinCoins(userAddress, currency);

      if (coins.length === 0) {
        return buildFailedStatus(booking.booking_id, "INSUFFICIENT_BALANCE",
          `No ${currency} found in wallet — use the faucet to get test ${currency}`);
      }

      const totalBalance = coins.reduce((sum, c) => sum + BigInt(c.balance), 0n);
      if (totalBalance < amountMicro) {
        return buildFailedStatus(booking.booking_id, "INSUFFICIENT_BALANCE",
          `Insufficient ${currency} — need ${feeAmount.toFixed(2)}, have ${(Number(totalBalance) / 1e6).toFixed(2)}`);
      }

      const primary = tx.object(coins[0].coinObjectId);
      if (coins.length > 1) {
        tx.mergeCoins(primary, coins.slice(1).map(c => tx.object(c.coinObjectId)));
      }
      const [paymentCoin] = tx.splitCoins(primary, [tx.pure.u64(amountMicro)]);
      tx.transferObjects([paymentCoin], tx.pure.address(feeReceiver));
    }

    // ── Mint BookingReceipt ──
    if (hasContract) {
      const onChain = await buildOnChainFields(booking, userAddress);
      const feeAmount = booking.fee.amount_after_coupon ?? onChain.amount_usdc;
      const amountMicro = Math.round(feeAmount * 1e6);
      const receipt = tx.moveCall({
        target: `${CONFIG.PACKAGE_ID}::booking::mint_receipt`,
        arguments: [
          tx.pure.string(onChain.commitment),
          tx.pure.string(onChain.store_type),
          tx.pure.string(onChain.slot_date),
          tx.pure.u8(onChain.party_size),
          tx.pure.u64(amountMicro),
          tx.pure.string(currency),
          tx.pure.string(onChain.fee_label),
          tx.object(CONFIG.POINTS_LEDGER_ID),
          tx.object(CONFIG.TIER_REGISTRY_ID),
        ],
      });
      tx.transferObjects([receipt], tx.pure.address(userAddress));
    }

    const result = await params.signAndExecute(tx);
    const txHash = result.digest;

    const txData = await client.waitForTransaction({
      digest: txHash,
      options: { showEffects: true, showObjectChanges: true },
    });

    if (txData.effects?.status?.status !== "success") {
      const errMsg = txData.effects?.status?.error ?? "Transaction failed on-chain";
      return buildFailedStatus(booking.booking_id, "TX_FAILED", errMsg);
    }

    const createdObjects = (txData.objectChanges ?? []).filter((c) => c.type === "created");
    const receiptObjectId = createdObjects.length > 0
      ? (createdObjects[0] as { objectId: string }).objectId
      : txHash;

    if (hasFee) {
      const feeAmount = booking.fee.amount_after_coupon ?? booking.fee.amount_usdc;
      paymentInfo = {
        tx_hash: txHash,
        amount_usdc: feeAmount,
        token: currency,
        chain: `sui:${CONFIG.SUI_NETWORK}`,
        protocol: "s402",
        refundable: booking.fee.refundable,
      };
    }

    const receiptInfo: ReceiptInfo = { object_id: receiptObjectId, tx_hash: txHash };
    const isFree = !booking.fee.has_fee;
    const isPromo = isFree && !!booking.fee.label && booking.fee.label !== "";
    const feeAmount = booking.fee.amount_after_coupon ?? booking.fee.amount_usdc;

    return buildStatus(
      isPromo ? "promo" : isFree ? "free" : "success",
      booking,
      paymentInfo,
      receiptInfo,
      isPromo
        ? booking.fee.sublabel || booking.fee.label
        : isFree
          ? "No reservation fee"
          : `Paid ${feeAmount.toFixed(2)} ${currency}`,
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.includes("Insufficient") || msg.includes("No ")) {
      return buildFailedStatus(booking.booking_id, "INSUFFICIENT_BALANCE", msg);
    }
    if (msg.includes("rejected") || msg.includes("denied")) {
      return buildFailedStatus(booking.booking_id, "USER_REJECTED", "Transaction rejected by user");
    }
    return buildFailedStatus(booking.booking_id, "TX_FAILED", msg);
  }
}

function buildStatus(
  status: PaymentStatus["status"],
  booking: BookingData,
  payment: PaymentInfo | null,
  receipt: ReceiptInfo | null,
  message: string,
): PaymentStatus {
  return {
    status,
    booking_id: booking.booking_id,
    payment,
    receipt,
    message,
    error_code: null,
    metadata: status === "promo" ? { promo_note: booking.fee.sublabel } : null,
    points: null,
  };
}

function buildFailedStatus(bookingId: string, errorCode: string, message: string): PaymentStatus {
  return {
    status: "failed",
    booking_id: bookingId,
    payment: null,
    receipt: null,
    message,
    error_code: errorCode,
    metadata: null,
    points: null,
  };
}

export async function sendPaymentCallback(
  callbackUrl: string,
  paymentStatus: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; points?: { earned: number; balance: number } }> {
  try {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...paymentStatus, timestamp: new Date().toISOString() }),
    });
    if (!response.ok) return { ok: false, error: `Callback failed: ${response.status}` };
    const data = await response.json() as { points?: { earned: number; balance: number } };
    return { ok: true, points: data.points };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : "Callback network error" };
  }
}
