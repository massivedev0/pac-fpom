import {
  Account,
  JsonRpcProvider,
  MRC20,
  Operation,
  OperationStatus,
  formatMas,
  formatUnits,
} from "@massalabs/massa-web3";
import { type FastifyBaseLogger } from "fastify";
import { type AppConfig } from "./config.js";

export type PayoutBalanceSnapshot = {
  payoutAddress: string;
  masBalanceRaw: string;
  masBalanceMas: string;
  fpomBalanceRaw: string;
  fpomBalanceTokens: string;
  tokenDecimals: number;
};

export type PayoutExecutionResult =
  | {
      outcome: "paid";
      txHash: string;
      rawAmount: string;
      tokenDecimals: number;
      observedStatus: string;
      balanceSnapshot?: PayoutBalanceSnapshot;
      projectedFpomBalanceRaw?: string;
    }
  | {
      outcome: "pending";
      txHash: string;
      rawAmount: string;
      tokenDecimals: number;
      observedStatus: string;
      balanceSnapshot?: PayoutBalanceSnapshot;
      projectedFpomBalanceRaw?: string;
    }
  | {
      outcome: "failed";
      txHash?: string;
      rawAmount: string;
      tokenDecimals: number;
      observedStatus: string;
      error: string;
      balanceSnapshot?: PayoutBalanceSnapshot;
      projectedFpomBalanceRaw?: string;
    };

export type PayoutReconcileResult =
  | {
      outcome: "paid";
      txHash: string;
      observedStatus: string;
    }
  | {
      outcome: "pending";
      txHash: string;
      observedStatus: string;
    }
  | {
      outcome: "failed";
      txHash: string;
      observedStatus: string;
      error: string;
    };

export type PayoutSender = {
  isConfigured: () => boolean;
  getBalanceSnapshot?: () => Promise<PayoutBalanceSnapshot>;
  sendTokenPayout: (input: {
    claimId: string;
    recipientAddress: string;
    amountTokens: number;
  }) => Promise<PayoutExecutionResult>;
  reconcilePayout: (txHash: string) => Promise<PayoutReconcileResult>;
};

type MassaRuntime = {
  provider: JsonRpcProvider;
  token: MRC20;
  decimals: number;
};

/**
 * Converts runtime balance value into bigint
 *
 * @param {bigint | { toString(): string }} value Bigint-like runtime balance
 * @returns {bigint} Normalized bigint balance
 */
function toBigIntValue(value: bigint | { toString(): string }): bigint {
  return typeof value === "bigint" ? value : BigInt(value.toString());
}

/**
 * Builds balance snapshot for payout wallet
 *
 * @param {MassaRuntime} runtime Initialized Massa runtime
 * @returns {Promise<PayoutBalanceSnapshot>} Current MAS and FPOM balances
 */
async function buildBalanceSnapshot(runtime: MassaRuntime): Promise<PayoutBalanceSnapshot> {
  const { provider, token, decimals } = runtime;
  const [masBalance, fpomBalance] = await Promise.all([
    provider.balance(),
    token.balanceOf(String(provider.address)),
  ]);
  const masBalanceRaw = toBigIntValue(masBalance);
  const fpomBalanceRaw = toBigIntValue(fpomBalance);

  return {
    payoutAddress: String(provider.address),
    masBalanceRaw: masBalanceRaw.toString(),
    masBalanceMas: formatMas(masBalanceRaw),
    fpomBalanceRaw: fpomBalanceRaw.toString(),
    fpomBalanceTokens: formatUnits(fpomBalanceRaw, decimals),
    tokenDecimals: decimals,
  };
}

/**
 * Classifies payout failure into a readable machine-friendly reason
 *
 * @param {unknown} error Unknown thrown value
 * @returns {string} Classified error reason
 */
function classifyPayoutError(error: unknown): string {
  if (error instanceof Error) {
    const rawMessage = `${error.name}:${error.message}`.replace(/\s+/g, " ").trim();
    const normalized = rawMessage.toLowerCase();

    if (error.name === "ErrorInsufficientBalance") {
      return `insufficient_mas_balance:${error.message}`;
    }
    if (
      normalized.includes("timeout") ||
      normalized.includes("abort") ||
      normalized.includes("timed out")
    ) {
      return `rpc_timeout:${rawMessage}`;
    }
    if (
      normalized.includes("fetch failed") ||
      normalized.includes("network") ||
      normalized.includes("econnrefused") ||
      normalized.includes("enotfound") ||
      normalized.includes("socket")
    ) {
      return `rpc_unreachable:${rawMessage}`;
    }

    return rawMessage || "payout_error";
  }

  return String(error || "payout_error");
}

/**
 * Converts Massa web3 enum value into readable label
 *
 * @param {OperationStatus} status Raw operation status
 * @returns {string} Human-readable status label
 */
function mapOperationStatusLabel(status: OperationStatus): string {
  return OperationStatus[status] ?? `UNKNOWN_${status}`;
}

/**
 * Checks whether observed operation status is final success
 *
 * @param {OperationStatus} status Raw operation status
 * @returns {boolean} True when operation fully succeeded
 */
function isFinalSuccessStatus(status: OperationStatus): boolean {
  return status === OperationStatus.Success;
}

/**
 * Checks whether observed operation status is terminal failure
 *
 * @param {OperationStatus} status Raw operation status
 * @returns {boolean} True when operation failed
 */
function isFailureStatus(status: OperationStatus): boolean {
  return status === OperationStatus.SpeculativeError || status === OperationStatus.Error;
}

/**
 * Converts integer token amount into raw on-chain units
 *
 * @param {number} amountTokens Whole-token amount
 * @param {number} decimals Token decimals
 * @returns {bigint} Raw token amount
 */
function toRawTokenAmount(amountTokens: number, decimals: number): bigint {
  if (!Number.isSafeInteger(amountTokens) || amountTokens <= 0) {
    throw new Error(`invalid_reward_amount:${amountTokens}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`invalid_token_decimals:${decimals}`);
  }
  return BigInt(amountTokens) * 10n ** BigInt(decimals);
}

/**
 * Creates payout sender backed by Massa JSON-RPC and MRC20 transfer
 *
 * @param {AppConfig} config Backend config
 * @param {FastifyBaseLogger} logger Fastify logger instance
 * @returns {PayoutSender | null} Configured payout sender or null when wallet key is missing
 */
export function createMassaPayoutSender(
  config: AppConfig,
  logger: FastifyBaseLogger,
): PayoutSender | null {
  if (!config.massaRewardWalletPk.trim()) {
    return null;
  }

  let runtimePromise: Promise<MassaRuntime> | null = null;

  /**
   * Lazily initializes account, provider, and token wrapper
   *
   * @returns {Promise<MassaRuntime>} Cached runtime dependencies
   */
  async function getRuntime(): Promise<MassaRuntime> {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const account = await Account.fromPrivateKey(config.massaRewardWalletPk.trim());
        const provider = config.massaRpcUrl
          ? JsonRpcProvider.fromRPCUrl(config.massaRpcUrl, account)
          : JsonRpcProvider.mainnet(account);
        const token = new MRC20(provider, config.fpomContractAddress);
        const decimals = await token.decimals();

        logger.info(
          {
            payoutAddress: provider.address,
            fpomContractAddress: config.fpomContractAddress,
            massaRpcUrl: config.massaRpcUrl || "mainnet_default",
            tokenDecimals: decimals,
          },
          "Massa payout sender initialized",
        );

        return {
          provider,
          token,
          decimals,
        };
      })().catch((error) => {
        runtimePromise = null;
        throw error;
      });
    }

    return runtimePromise;
  }

  /**
   * Waits for payout operation status according to configured confirmation mode
   *
   * @param {string} txHash Submitted operation hash
   * @param {JsonRpcProvider} provider Bound RPC provider
   * @returns {Promise<OperationStatus>} Observed operation status
   */
  async function waitOperationStatus(
    txHash: string,
    provider: JsonRpcProvider,
  ): Promise<OperationStatus> {
    const operation = new Operation(provider, txHash);
    const waitedStatus =
      config.massaOperationWait === "speculative"
        ? await operation.waitSpeculativeExecution(
            config.massaOperationTimeoutMs,
            config.massaOperationPollIntervalMs,
          )
        : await operation.waitFinalExecution(
            config.massaOperationTimeoutMs,
            config.massaOperationPollIntervalMs,
          );

    if (waitedStatus !== OperationStatus.NotFound) {
      return waitedStatus;
    }

    return operation.getStatus();
  }

  return {
    isConfigured() {
      return true;
    },

    async getBalanceSnapshot() {
      return buildBalanceSnapshot(await getRuntime());
    },

    async sendTokenPayout(input) {
      const runtime = await getRuntime();
      const { token, decimals } = runtime;
      const rawAmount = toRawTokenAmount(input.amountTokens, decimals);
      const balanceSnapshot = await buildBalanceSnapshot(runtime);
      const fpomBalanceRaw = BigInt(balanceSnapshot.fpomBalanceRaw);
      if (fpomBalanceRaw < rawAmount) {
        return {
          outcome: "failed",
          txHash: undefined,
          rawAmount: rawAmount.toString(),
          tokenDecimals: decimals,
          observedStatus: "PRECHECK_FAILED",
          error: `insufficient_fpom_balance:have=${balanceSnapshot.fpomBalanceTokens}:need=${formatUnits(rawAmount, decimals)}`,
          balanceSnapshot,
          projectedFpomBalanceRaw: balanceSnapshot.fpomBalanceRaw,
        };
      }

      try {
        const operation = await token.transfer(input.recipientAddress, rawAmount);
        const txHash = operation.id;

        return {
          outcome: "pending",
          txHash,
          rawAmount: rawAmount.toString(),
          tokenDecimals: decimals,
          observedStatus: "SUBMITTED",
          balanceSnapshot,
          projectedFpomBalanceRaw: (fpomBalanceRaw - rawAmount).toString(),
        };
      } catch (error) {
        return {
          outcome: "failed",
          txHash: undefined,
          rawAmount: rawAmount.toString(),
          tokenDecimals: decimals,
          observedStatus: "SUBMIT_FAILED",
          error: classifyPayoutError(error),
          balanceSnapshot,
          projectedFpomBalanceRaw: balanceSnapshot.fpomBalanceRaw,
        };
      }
    },

    async reconcilePayout(txHash) {
      const { provider } = await getRuntime();
      const observedStatus = await waitOperationStatus(txHash, provider);
      const observedStatusLabel = mapOperationStatusLabel(observedStatus);

      if (isFinalSuccessStatus(observedStatus)) {
        return {
          outcome: "paid",
          txHash,
          observedStatus: observedStatusLabel,
        };
      }

      if (isFailureStatus(observedStatus)) {
        return {
          outcome: "failed",
          txHash,
          observedStatus: observedStatusLabel,
          error: `operation_failed:${observedStatusLabel}`,
        };
      }

      return {
        outcome: "pending",
        txHash,
        observedStatus: observedStatusLabel,
      };
    },
  };
}
