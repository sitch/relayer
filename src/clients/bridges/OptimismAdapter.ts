import { winston } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { constants } from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../../common";
import { OpStackAdapter } from "./OpStackAdapter";
const { TOKEN_SYMBOLS_MAP } = constants;

export class OptimismAdapter extends OpStackAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[],
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
  ) {
    super(
      10,
      // L1 Custom bridge addresses
      {
        [TOKEN_SYMBOLS_MAP.DAI.addresses[1]]: CONTRACT_ADDRESSES[1].daiOptimismBridge.address,
      },
      // L2 custom bridge addresses
      {
        [TOKEN_SYMBOLS_MAP.DAI.addresses[1]]: CONTRACT_ADDRESSES[10].daiOptimismBridge.address,
      },
      logger,
      spokePoolClients,
      monitoredAddresses,
      senderAddress
    );
  }
}
