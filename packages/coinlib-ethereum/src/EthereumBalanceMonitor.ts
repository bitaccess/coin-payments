import {
  BlockInfo,
  BalanceActivity,
  BalanceActivityCallback,
  BalanceMonitor,
  FilterBlockAddressesCallback,
  GetBalanceActivityOptions,
  NetworkType,
  RetrieveBalanceActivitiesResult,
  NewBlockCallback,
} from '@bitaccess/coinlib-common'
import { isUndefined, Numeric } from '@faast/ts-common'

import BigNumber from 'bignumber.js'
import { EventEmitter } from 'events'
import { get } from 'lodash'
import { BlockTransactionObject, Transaction } from 'web3-eth'
import { EthereumPaymentsUtils } from './EthereumPaymentsUtils'
import { NetworkData } from './NetworkData'
import { EthereumBalanceMonitorConfig, EthereumBlock, EthereumStandardizedTransaction } from './types'

export class EthereumBalanceMonitor implements BalanceMonitor {
  readonly coinName: string
  readonly coinSymbol: string
  readonly utils: EthereumPaymentsUtils
  readonly networkType: NetworkType
  readonly events = new EventEmitter()

  constructor(config: EthereumBalanceMonitorConfig) {
    this.coinName = config.utils.coinName
    this.coinSymbol = config.utils.coinSymbol
    this.utils = config.utils
    this.networkType = config.network || NetworkType.Mainnet
  }
  async init(): Promise<void> {
    await this.utils.networkData.connectBlockBook()
  }

  async destroy(): Promise<void> {
    this.events.removeAllListeners('tx')

    await this.utils.networkData.disConnectBlockBook()
  }

  async subscribeAddresses(addresses: string[]): Promise<void> {
    const validAddresses = addresses.filter(address => this.utils.isValidAddress(address))

    await this.utils.networkData.subscribeAddresses(validAddresses, async (address, standardizedTx, rawTx) => {
      this.events.emit('tx', { address, tx: rawTx })

      const activity = await this.txToBalanceActivity(address, standardizedTx)
      if (activity) {
        this.events.emit('activity', { activity, tx: rawTx })
      }
    })
  }

  onBalanceActivity(callbackFn: BalanceActivityCallback) {
    this.events.on('activity', ({ activity, tx }) => {
      callbackFn(activity, tx)?.catch(e =>
        this.utils.logger.error(`Error in ${this.coinSymbol} ${this.networkType} onBalanceActivity callback`, e),
      )
    })
  }

  // WIP
  async retrieveBalanceActivities(
    address: string,
    callbackFn: BalanceActivityCallback,
    options: GetBalanceActivityOptions,
  ): Promise<RetrieveBalanceActivitiesResult> {
    const { from: fromOption, to: toOption } = options
    const from = new BigNumber(
      isUndefined(fromOption) ? 0 : Numeric.is(fromOption) ? fromOption : fromOption.confirmationNumber,
    ).toNumber()
    const to = new BigNumber(
      isUndefined(toOption) ? 'Infinity' : Numeric.is(toOption) ? toOption.toString() : toOption.confirmationNumber,
    ).toNumber()

    let page = 1

    const addressDetails = await this.utils.networkData.getAddressDetails(address, { page, from, to })

    return {
      from: 'from',
      to: 'to',
    }
  }

  async retrieveBlockBalanceActivities(
    blockId: string | number,
    callbackFn: BalanceActivityCallback,
    filterRelevantAddresses: FilterBlockAddressesCallback,
  ): Promise<BlockInfo> {
    const blockDetails: BlockInfo = await this.utils.networkData.getBlock(blockId)

    const transactions = get(blockDetails.raw, 'transactions', []) as EthereumStandardizedTransaction[]
    const addressTransactions: { [address: string]: Set<EthereumStandardizedTransaction> } = {}

    for (const tx of transactions) {
      const fromAddress = tx.from
      const toAddress = tx.to

      addressTransactions[fromAddress] = (addressTransactions[fromAddress] ?? new Set()).add(tx)
      addressTransactions[toAddress] = (addressTransactions[toAddress] ?? new Set()).add(tx)
    }

    const relevantAddresses = await filterRelevantAddresses(Array.from(Object.keys(addressTransactions)), {
      ...blockDetails,
      page: 1,
    })

    for (const relevantAddress of relevantAddresses) {
      const relevantAddressTransactions = addressTransactions[relevantAddress]
      for (const tx of relevantAddressTransactions) {
        const activity = await this.txToBalanceActivity(relevantAddress, tx)
        if (activity) {
          await callbackFn(activity)
        }
      }
    }

    return blockDetails
  }

  async txToBalanceActivity(address: string, tx: EthereumStandardizedTransaction): Promise<BalanceActivity> {
    const isSender = address === tx.from
    const isRecipient = address === tx.to

    let type: BalanceActivity['type'] | undefined

    if (isSender) {
      type = 'out'
    } else if (isRecipient) {
      type = 'in'
    }

    if (!type) {
      throw new Error(`Unable to resolve balanceActivity type, address = ${address}, txHash=${tx.txHash}`)
    }

    const balanceActivity: BalanceActivity = {
      type,
      networkType: this.networkType,
      networkSymbol: this.coinSymbol,
      assetSymbol: this.coinSymbol,
      address,
      externalId: tx.txHash,
      activitySequence: tx.nonce.toString(),
      confirmationId: tx.blockHash ?? '',
      confirmationNumber: tx.blockHeight,
      timestamp: tx.blockTime,
      amount: this.utils.toMainDenomination(tx.value),
      extraId: null,
    }

    return balanceActivity
  }

  async subscribeNewBlock(callbackFn: NewBlockCallback): Promise<void> {
    await this.utils.networkData.subscribeNewBlock(callbackFn)
  }
}
