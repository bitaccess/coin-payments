import {
  PaymentsUtils,
  Payport,
  AutoFeeLevels,
  FeeRate,
  FeeRateType,
  NetworkType,
  BalanceResult,
  TransactionStatus,
  BlockInfo,
  BigNumber,
  buffToHex,
  hexToBuff,
  strip0x,
} from '@bitaccess/coinlib-common'
import { Logger, DelegateLogger, assertType, isNull, Numeric, isNumber } from '@faast/ts-common'
import { BlockbookEthereum } from 'blockbook-client'
import InputDataDecoder from 'ethereum-input-data-decoder'
import Web3 from 'web3'
import Contract from 'web3-eth-contract'

import {
  PACKAGE_NAME,
  DEFAULT_ADDRESS_FORMAT,
  MIN_SWEEPABLE_WEI,
  TOKEN_METHODS_ABI,
  TOKEN_WALLET_ABI,
  TOKEN_WALLET_ABI_LEGACY,
  FULL_ERC20_TOKEN_METHODS_ABI,
  MIN_CONFIRMATIONS,
  DEFAULT_MAINNET_CONSTANTS,
  DEFAULT_TESTNET_CONSTANTS,
  DEFAULT_DECIMALS,
} from './constants'
import {
  EthereumAddressFormat,
  EthereumAddressFormatT,
  EthereumPaymentsUtilsConfig,
  EthereumStandardizedERC20Transaction,
  EthereumTransactionInfo,
  NetworkConstants,
} from './types'
import { isValidXprv, isValidXpub } from './bip44'
import { NetworkData } from './NetworkData'
import { retryIfDisconnected } from './utils'
import { UnitConvertersUtil } from './UnitConvertersUtil'
import * as SIGNATURE from './erc20/constants'
import { deriveCreate2Address } from './erc20/utils'
import * as ethJsUtil from 'ethereumjs-util'

export class EthereumPaymentsUtils extends UnitConvertersUtil implements PaymentsUtils {
  readonly networkName: string
  readonly networkType: NetworkType
  readonly coinSymbol: string
  readonly coinName: string
  readonly coinDecimals: number
  readonly tokenAddress?: string
  readonly networkConstants: NetworkConstants
  readonly nativeCoinSymbol: string
  readonly nativeCoinName: string
  readonly nativeCoinDecimals: number

  logger: Logger
  web3: Web3
  eth: Web3['eth']
  networkData: NetworkData
  blockBookApi?: BlockbookEthereum

  constructor(config: EthereumPaymentsUtilsConfig) {
    super({
      coinDecimals: config.decimals,
      nativeDecimals: config.networkConstants?.nativeCoinDecimals ?? DEFAULT_DECIMALS
    })

    this.logger = new DelegateLogger(config.logger, PACKAGE_NAME)
    this.networkType = config.network || NetworkType.Mainnet
    this.networkConstants = {
      ...(this.networkType === NetworkType.Mainnet
        ? DEFAULT_MAINNET_CONSTANTS
        : DEFAULT_TESTNET_CONSTANTS),
      ...config.networkConstants,
    }
    this.networkName = this.networkConstants.networkName
    this.nativeCoinName = this.networkConstants.nativeCoinName
    this.nativeCoinSymbol = this.networkConstants.nativeCoinSymbol
    this.nativeCoinDecimals = this.networkConstants.nativeCoinDecimals

    if (config.tokenAddress) {
      // ERC20 case
      if (!config.name) {
        throw new Error(`Expected config.name to be provided for tokenAddress ${config.tokenAddress}`)
      }
      if (!config.symbol) {
        throw new Error(`Expected config.symbol to be provided for tokenAddress ${config.tokenAddress}`)
      }
      if (!config.decimals) {
        throw new Error(`Expected config.decimals to be provided for tokenAddress ${config.tokenAddress}`)
      }
    } else {
      // ether case
      if (config.name && config.name !== this.nativeCoinName) {
        throw new Error(`Unexpected config.name ${config.name} provided without config.tokenAddress`)
      }
      if (config.symbol && config.symbol !== this.nativeCoinSymbol) {
        throw new Error(`Unexpected config.symbol ${config.symbol} provided without config.tokenAddress`)
      }
      if (config.decimals && config.decimals !== this.nativeCoinDecimals) {
        throw new Error(`Unexpected config.decimals ${config.decimals} provided without config.tokenAddress`)
      }
    }

    this.coinName = config.name ?? this.nativeCoinName
    this.coinSymbol = config.symbol ?? this.nativeCoinSymbol
    this.coinDecimals = config.decimals ?? this.nativeCoinDecimals

    const networkNameEnv = this.networkConstants.networkName.toUpperCase().replace(/[- ]/, '_')
    const fullNode = config.fullNode
      ?? process.env[`${networkNameEnv}_FULL_NODE`] // ie ETHEREUM_MAINNET_FULL_NODE
    const blockbookNode = config.blockbookNode
      ?? process.env[`${networkNameEnv}_BLOCKBOOK_NODE`]?.split(',') // ie ETHEREUM_MAINNET_BLOCKBOOK_NODE
      ?? null

    this.networkData = new NetworkData({
      web3Config: {
        web3: config.web3,
        fullNode: fullNode,
        providerOptions: config.providerOptions,
      },
      parityUrl: config.parityNode,
      logger: this.logger,
      blockBookConfig: {
        nodes: blockbookNode,
        api: config.blockbookApi,
        requestTimeoutMs: config.requestTimeoutMs,
      },
      gasStationUrl: config.gasStation,
      requestTimeoutMs: config.requestTimeoutMs,
    })

    this.web3 = this.networkData.web3Service.web3
    this.eth = this.web3.eth
    this.blockBookApi = this.networkData.blockBookService.api ?? undefined

    // standardize call depends on this.web3 so it must come last here
    this.tokenAddress = config.tokenAddress ? this.standardizeAddressOrThrow(config.tokenAddress) : undefined
  }

  protected newContract(...args: ConstructorParameters<typeof Contract>) {
    const contract = new Contract(...args)
    contract.setProvider(this.eth.currentProvider)
    return contract
  }

  async init() {}
  async destroy() {}

  isValidAddress(address: string, options: { format?: string } = {}): boolean {
    const { format } = options
    if (format === EthereumAddressFormat.Lowercase) {
      return this.web3.utils.isAddress(address) && address === address.toLowerCase()
    } else if (format === EthereumAddressFormat.Checksum) {
      return this.web3.utils.checkAddressChecksum(address)
    }
    return this.web3.utils.isAddress(address)
  }

  standardizeAddress(address: string, options?: { format?: string }): string | null {
    // Don't pass options into isValidAddress because it'll check if it matches the format
    // option, but we want to allow ANY valid address to be standardized by this method.
    if (!this.isValidAddress(address)) {
      return null
    }
    const format = assertType(EthereumAddressFormatT, options?.format ?? DEFAULT_ADDRESS_FORMAT, 'format')
    if (format === EthereumAddressFormat.Lowercase) {
      return address.toLowerCase()
    } else {
      return this.web3.utils.toChecksumAddress(address)
    }
  }

  standardizeAddressOrThrow(address: string, options?: { format?: string }): string {
    const standardized = this.standardizeAddress(address, options)
    if (standardized === null) {
      throw new Error(`Invalid ${this.networkName} address: ${address}`)
    }
    return standardized
  }

  isValidExtraId(extraId: unknown): boolean {
    return false
  }

  // XXX Payport methods can be moved to payments-common
  isValidPayport(payport: Payport): payport is Payport {
    return Payport.is(payport) && !this._getPayportValidationMessage(payport)
  }

  validatePayport(payport: Payport): void {
    const message = this._getPayportValidationMessage(payport)
    if (message) {
      throw new Error(message)
    }
  }

  getPayportValidationMessage(payport: Payport): string | undefined {
    try {
      payport = assertType(Payport, payport, 'payport')
    } catch (e) {
      return e.message
    }
    return this._getPayportValidationMessage(payport)
  }

  isValidXprv(xprv: string): boolean {
    return isValidXprv(xprv)
  }

  isValidXpub(xpub: string): boolean {
    return isValidXpub(xpub)
  }

  isValidPrivateKey(prv: string): boolean {
    try {
      return ethJsUtil.isValidPrivate(hexToBuff(prv))
    } catch (e) {
      return false
    }
  }

  isValidPublicKey(pub: string): boolean {
    try {
      return ethJsUtil.isValidPublic(hexToBuff(pub), true)
    } catch (e) {
      return false
    }
  }

  isAddressEqual(address1: string, address2: string) {
    return strip0x(address1.toLowerCase()) === strip0x(address2.toLowerCase())
  }

  privateKeyToAddress(prv: string): string {
    return this.standardizeAddressOrThrow(buffToHex(ethJsUtil.privateToAddress(hexToBuff(prv))))
  }

  publicKeyToAddress(pub: string): string {
    return this.standardizeAddressOrThrow(buffToHex(ethJsUtil.publicToAddress(hexToBuff(pub), true)))
  }

  private _getPayportValidationMessage(payport: Payport): string | undefined {
    try {
      const { address } = payport
      if (!this.isValidAddress(address)) {
        return `Invalid ${this.networkName} payport address`
      }
    } catch (e) {
      return `Invalid ${this.networkName} payport address`
    }
    return undefined
  }

  async getFeeRateRecommendation(level: AutoFeeLevels): Promise<FeeRate> {
    const gasPrice = await this.networkData.getGasPrice(level)
    return {
      feeRate: gasPrice,
      feeRateType: FeeRateType.BasePerWeight,
    }
  }

  async _retryDced<T>(fn: () => Promise<T>): Promise<T> {
    return retryIfDisconnected(fn, this.logger)
  }

  async getCurrentBlockNumber() {
    return this.networkData.getCurrentBlockNumber()
  }


  isAddressBalanceSweepable(balanceEth: Numeric): boolean {
    return this.toBaseDenominationBigNumberNative(balanceEth).gt(MIN_SWEEPABLE_WEI)
  }

  async getAddressBalanceERC20(address: string, tokenAddress: string): Promise<BalanceResult> {
    const balance = await this.networkData.getAddressBalanceERC20(address, tokenAddress)

    const sweepable = this.toMainDenominationBigNumber(balance).gt(0)

    return {
      confirmedBalance: this.toMainDenomination(balance),
      unconfirmedBalance: '0',
      spendableBalance: this.toMainDenomination(balance),
      sweepable,
      requiresActivation: false,
    }
  }

  async getAddressBalance(address: string): Promise<BalanceResult> {
    if (this.tokenAddress) {
      return this.getAddressBalanceERC20(address, this.tokenAddress)
    }
    const balance = await this.networkData.getAddressBalance(address)
    const confirmedBalance = this.toMainDenomination(balance).toString()
    const sweepable = this.isAddressBalanceSweepable(confirmedBalance)

    return {
      confirmedBalance,
      unconfirmedBalance: '0',
      spendableBalance: confirmedBalance,
      sweepable,
      requiresActivation: false,
    }
  }

  async getAddressNextSequenceNumber(address: string) {
    return this.networkData.getNonce(address)
  }

  async getAddressUtxos() {
    return []
  }

  private getErc20TransferLogAmount(
    receipt: EthereumStandardizedERC20Transaction['receipt'],
    tokenDecimals: number,
    txHash: string,
  ): string {
    const txReceiptLogs = receipt.logs
    const transferLog = txReceiptLogs.find(log => log.topics[0] === SIGNATURE.LOG_TOPIC0_ERC20_SWEEP)
    if (!transferLog) {
      this.logger.warn(`Transaction ${txHash} was an ERC20 sweep but cannot find log for Transfer event`)
      return '0'
    }

    const unitConverter = this.getCustomUnitConverter(tokenDecimals)

    return unitConverter.toMainDenominationString(transferLog.data)
  }

  private async getTransactionInfoERC20(txId: string, tokenAddress: string): Promise<EthereumTransactionInfo> {
    const erc20Tx = await this.networkData.getERC20Transaction(txId, tokenAddress)

    let fromAddress = erc20Tx.from
    let toAddress = erc20Tx.to ?? tokenAddress
    const tokenDecimals = new BigNumber(erc20Tx.tokenDecimals).toNumber()
    const { txHash } = erc20Tx

    let status: TransactionStatus = TransactionStatus.Pending
    let isExecuted = false

    // XXX it is suggested to keep 12 confirmations
    // https://ethereum.stackexchange.com/questions/319/what-number-of-confirmations-is-considered-secure-in-ethereum
    const isConfirmed = erc20Tx.confirmations > Math.max(MIN_CONFIRMATIONS, 12)

    if (isConfirmed) {
      status = TransactionStatus.Confirmed
      isExecuted = true
    }

    const tokenDecoder = new InputDataDecoder(FULL_ERC20_TOKEN_METHODS_ABI)
    const txInput = erc20Tx.txInput
    let amount = ''

    const isERC20Transfer = txInput.startsWith(SIGNATURE.ERC20_TRANSFER)
    const isERC20SweepContractDeploy = txInput.startsWith(SIGNATURE.ERC20_SWEEP_CONTRACT_DEPLOY)
    const isERC20SweepContractDeployLegacy = txInput.startsWith(SIGNATURE.ERC20_SWEEP_CONTRACT_DEPLOY_LEGACY)
    const isERC20Proxy = txInput.startsWith(SIGNATURE.ERC20_PROXY)
    const isERC20Sweep = txInput.startsWith(SIGNATURE.ERC20_SWEEP)
    const isERC20SweepLegacy = txInput.startsWith(SIGNATURE.ERC20_SWEEP_LEGACY)

    if (isERC20Transfer) {
      if (!this.isAddressEqual(toAddress, tokenAddress)) {
        throw new Error(`Transaction ${txId} was sent to different contract: ${toAddress}, Expected: ${tokenAddress}`)
      }
      const txData = tokenDecoder.decodeData(txInput)

      toAddress = txData.inputs[0]

      // USDT token has decimal place of 6, unlike other tokens that are 18 decimals;
      // so we have to use a custom unitConverter, the default one uses that 18 decimals
      const customUnitConverter = this.getCustomUnitConverter(tokenDecimals)

      const inputAmount = txData.inputs[1].toString()

      amount = customUnitConverter.toMainDenominationString(inputAmount)

      const actualAmount = this.getErc20TransferLogAmount(erc20Tx.receipt, tokenDecimals, txHash)

      if (isExecuted && amount !== actualAmount) {
        this.logger.warn(
          `Transaction ${txHash} tried to transfer ${amount} but only ${actualAmount} was actually transferred`,
        )
      }
    } else if (isERC20SweepContractDeploy || isERC20SweepContractDeployLegacy || isERC20Proxy) {
      amount = '0'
    } else if (isERC20Sweep) {
      const tokenDecoder = new InputDataDecoder(TOKEN_WALLET_ABI)
      const txData = tokenDecoder.decodeData(txInput)

      if (txData.inputs.length !== 4) {
        throw new Error(`Transaction ${txHash} has not recognized number of inputs ${txData.inputs.length}`)
      }
      // For ERC20 sweeps:
      // tx.from is the contract address
      // inputs[0] is salt
      // inputs[1] is the ERC20 contract address (this.tokenAddress)
      // inputs[2] is the recipient of the funds (toAddress)
      // inputs[3] is the amount
      const sweepContractAddress = toAddress
      if (!sweepContractAddress) {
        throw new Error(`Transaction ${txHash} should have a to address destination`)
      }

      const create2Addr = deriveCreate2Address(sweepContractAddress, buffToHex(txData.inputs[0]), true)

      fromAddress = create2Addr
      toAddress = txData.inputs[2]
      amount = this.getErc20TransferLogAmount(erc20Tx.receipt, tokenDecimals, txHash)
    } else if (isERC20SweepLegacy) {
      const tokenDecoder = new InputDataDecoder(TOKEN_WALLET_ABI_LEGACY)
      const txData = tokenDecoder.decodeData(txInput)

      if (txData.inputs.length !== 2) {
        throw new Error(`Transaction ${txHash} has not recognized number of inputs ${txData.inputs.length}`)
      }
      // For ERC20 legacy sweeps:
      // tx.to is the sweep contract address and source of funds (fromAddress)
      // tx.from is the contract owner address
      // inputs[0] is the ERC20 contract address (this.tokenAddress)
      // inputs[1] is the recipient of the funds (toAddress)
      const sweepContractAddress = toAddress
      if (!sweepContractAddress) {
        throw new Error(`Transaction ${txHash} should have a to address destination`)
      }

      fromAddress = sweepContractAddress
      toAddress = txData.inputs[1]

      amount = this.getErc20TransferLogAmount(erc20Tx.receipt, tokenDecimals, txHash)
    } else {
      throw new Error('tx is neither ERC20 token transfer nor sweep')
    }

    const fee = this.toMainDenomination(new BigNumber(erc20Tx.gasPrice).multipliedBy(erc20Tx.gasUsed))

    const currentBlockNumber = await this.getCurrentBlockNumber()

    const result: EthereumTransactionInfo = {
      id: txHash,
      amount,
      fromAddress: this.standardizeAddressOrThrow(fromAddress),
      toAddress: this.standardizeAddressOrThrow(toAddress),
      fromExtraId: null,
      toExtraId: null,
      fromIndex: null,
      toIndex: null,
      fee,
      sequenceNumber: erc20Tx.nonce,
      weight: erc20Tx.gasUsed,
      isExecuted,
      isConfirmed,
      confirmations: erc20Tx.confirmations,
      confirmationId: erc20Tx.blockHash,
      confirmationTimestamp: erc20Tx.blockTime,
      confirmationNumber: erc20Tx.blockHeight,
      status,
      currentBlockNumber,
      data: {
        ...erc20Tx,
      },
    }

    return result
  }

  async getTransactionInfo(txid: string): Promise<EthereumTransactionInfo> {
    if (this.tokenAddress) {
      return this.getTransactionInfoERC20(txid, this.tokenAddress)
    }
    const tx = await this.networkData.getTransaction(txid)

    let status: TransactionStatus = TransactionStatus.Pending
    let isExecuted = false

    // XXX it is suggested to keep 12 confirmations
    // https://ethereum.stackexchange.com/questions/319/what-number-of-confirmations-is-considered-secure-in-ethereum
    const isConfirmed = tx.confirmations >= Math.max(MIN_CONFIRMATIONS, 12)

    if (isConfirmed) {
      status = TransactionStatus.Confirmed
      isExecuted = true
      if (!tx.status) {
        status = TransactionStatus.Failed
        isExecuted = false
      }
    }

    const currentBlockNumber = await this.getCurrentBlockNumber()

    const fee = this.toMainDenomination(new BigNumber(tx.gasPrice).multipliedBy(tx.gasUsed))
    const fromAddress = this.standardizeAddress(tx.from)
    const toAddress = this.standardizeAddress(tx.to ?? tx.contractAddress)

    const result: EthereumTransactionInfo = {
      id: tx.txHash,
      amount: this.toMainDenomination(tx.value),
      fromAddress,
      toAddress,
      fromExtraId: null,
      toExtraId: null,
      fromIndex: null,
      toIndex: null,
      fee,
      sequenceNumber: tx.nonce,
      weight: tx.gasUsed,
      isExecuted,
      isConfirmed,
      confirmations: tx.confirmations,
      confirmationId: tx.blockHash ?? null,
      confirmationTimestamp: tx.blockTime,
      confirmationNumber: tx.blockHeight,
      status,
      currentBlockNumber,
      data: {
        ...tx.raw,
        to: toAddress,
        from: fromAddress,
        contractAddress: tx.contractAddress,
      },
    }

    return result
  }

  async getBlock(id?: string | number): Promise<BlockInfo> {
    return this.networkData.getBlock(id ?? 'latest')
  }
}
