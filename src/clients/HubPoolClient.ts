import { spreadEvent, assign, Contract, winston, BigNumber } from "../utils";
import { Deposit } from "../interfaces/SpokePool";

export class HubPoolClient {
  // L1Token -> destinationChainId -> destinationToken
  private l1TokensToDestinationTokens: { [l1Token: string]: { [destinationChainId: number]: string } } = {};
  private l1Tokens: string[] = []; // L1Tokens. No tracking of enabled or disabled as not needed at this time.

  public isUpdated: boolean = false;
  public firstBlockToSearch: number;

  constructor(
    readonly logger: winston.Logger,
    readonly hubPool: Contract,
    readonly startingBlock: number = 0,
    readonly endingBlock: number | null = null
  ) {}

  getDestinationTokenForDeposit(deposit: Deposit) {
    const l1Token = this.getL1TokenForDeposit(deposit);
    const destinationToken = this.getDestinationTokenForL1TokenDestinationChainId(l1Token, deposit.destinationChainId);
    if (!destinationToken)
      this.logger.error({ at: "HubPoolClient", message: "No destination token found for deposit", deposit });
    return destinationToken;
  }

  getL1TokensToDestinationTokens() {
    return this.l1TokensToDestinationTokens;
  }

  getL1TokenForDeposit(deposit: Deposit) {
    let l1Token = null;
    Object.keys(this.l1TokensToDestinationTokens).forEach((_l1Token) => {
      if (this.l1TokensToDestinationTokens[_l1Token][deposit.originChainId.toString()] === deposit.originToken)
        l1Token = _l1Token;
    });
    return l1Token;
  }

  getDestinationTokenForL1TokenDestinationChainId(l1Token: string, destinationChainId: number) {
    return this.l1TokensToDestinationTokens[l1Token][destinationChainId];
  }

  async getCurrentPoolUtilization(l1Token: string) {
    return await this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token);
  }

  async getPostRelayPoolUtilization(l1Token: string, quoteBlockNumber: number, relaySize: BigNumber) {
    const blockOffset = { blockTag: quoteBlockNumber };
    const [current, post] = await Promise.all([
      this.hubPool.callStatic.liquidityUtilizationCurrent(l1Token, blockOffset),
      this.hubPool.callStatic.liquidityUtilizationPostRelay(l1Token, relaySize, blockOffset),
    ]);
    return { current, post };
  }

  getL1Tokens() {
    return this.l1Tokens;
  }

  async update() {
    const searchConfig = [this.firstBlockToSearch, this.endingBlock || (await this.hubPool.provider.getBlockNumber())];
    this.logger.debug({ at: "HubPoolClient", message: "Updating client", searchConfig });
    if (searchConfig[0] > searchConfig[1]) return; // If the starting block is greater than the ending block return.

    const [poolRebalanceRouteEvents, l1TokensEnabledForLPEvents] = await Promise.all([
      this.hubPool.queryFilter(this.hubPool.filters.SetPoolRebalanceRoute(), ...searchConfig),
      this.hubPool.queryFilter(this.hubPool.filters.L1TokenEnabledForLiquidityProvision(), ...searchConfig),
    ]);

    for (const event of poolRebalanceRouteEvents) {
      const args = spreadEvent(event);
      assign(this.l1TokensToDestinationTokens, [args.l1Token, args.destinationChainId], args.destinationToken);
    }

    for (const event of l1TokensEnabledForLPEvents) this.l1Tokens.push(spreadEvent(event).l1Token);

    this.isUpdated = true;
    this.firstBlockToSearch = searchConfig[1] + 1; // Next iteration should start off from where this one ended.

    this.logger.debug({ at: "HubPoolClient", message: "Client updated!" });
  }
}
